import {readFile, unlink, writeFile} from 'fs/promises';
import {tmpdir} from 'os';
import {basename, extname, join} from 'path';
import {tmpName} from 'tmp-promise';
import * as vscode from 'vscode';

export type ShowOption = 'terminal'|'task';

export const executeConversion = async (
  cwd: string|undefined, filename: string|undefined, input: string[],
  token?: vscode.CancellationToken, showOption?: ShowOption,
  disposables?: vscode.Disposable[],
  logging?: string[], forceConversionOnly?: true,
): Promise<string> => {
  let name = 'Main';
  let inFile: string;
  const microEbusdMode = !forceConversionOnly
  && (vscode.workspace.getConfiguration('ebus-notebook.ebusd').get('micro-ebusd-mode') as 'no'|'yes'|'inline' || 'no') !== 'no';
  const randomPart = (microEbusdMode ? '_g' : '_generatedMain_')
  +(0x1000000+Math.floor(Math.random()*0x1000000)).toString(16).substring(1)+'_';
  if (microEbusdMode) {
    // the circuit is taken from the file name by tsp2ebusd: ZZ.<circuit>.tsp
    let baseName = filename && basename(filename, extname(filename));
    let address = '08.'; // most used default address
    if (baseName) {
      const match = baseName.match(/^([0-9a-fA-F]{2}\.)/);
      if (match) {
        address = match[1];
        baseName = baseName.substring(3);
      } else {
        // simple check for non-commented @zz line in tsp
        for (const line of input) {
          // match '@zz(<dec-or-hex-with0x-prefix>)' without inline-comment prefix (this is weak and won't catch all cases, but better than nothing)
          const match = line.match(/^\s*@zz\s*\(\s*(0x[0-9a-f]{2}|[0-9]{1,3})\s*\)/);
          if (match) {
            const value = Number(match[1]);
            if (Number.isInteger(value) && value >= 0 && value <= 0xff) {
              address = (value|0x100).toString(16).substring(1)+'.';
            }
            break;
          }
        }
      }
      name = baseName.substring(0, 1).toUpperCase()+baseName.substring(1).replace(/[^0-9a-zA-Z._]/g, '_');
    }
    inFile = join(cwd ?? tmpdir(), `${address}${name}..${randomPart}.tsp`); // to avoid using circuit rename and/or undesired suffix
  } else {
    inFile = await tmpName({prefix: randomPart});
    if (cwd) {
      inFile = join(cwd, basename(inFile)+'.tsp');
    }
  }
  const outFile = await tmpName();
  const enhancedInput = [...input];
  enhancedInput.find((line, idx) => {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('import ') || line.startsWith('using ')) {
      if (line==='using Ebus;') {
        return true; // done
      }
      return; // continue
    }
    enhancedInput.splice(idx, 0, 'using Ebus;');
    return true; // give up
  });
  await writeFile(inFile, enhancedInput.join('\n'));
  disposables?.push(vscode.Disposable.from({dispose: () => {
    try {
      void unlink(inFile);
    } catch (_) {
      // ignore
    }
    try {
      void unlink(outFile);
    } catch (_) {
      // ignore
    }
  }}));
  const resolveOutput = async (res: (value: string) => void, rej: (reason?: any) => void, dispose?: vscode.Disposable, failed?: string) => {
    try {
      let output;
      try {
        output = (await readFile(outFile, 'utf-8')).trim();
      } catch (_e) {
        // ignore
      }
      if (failed) {
        return rej(failed+(output ? ', \output:\n'+output:''));
      }
      if (output!==undefined) {
        const match = new RegExp(randomPart+'[^,]*');
        let circuitColumn = 1;
        output = output.split('\n').map((line, idx) => {
          if (idx===0) {
            circuitColumn = line.split(',').indexOf('circuit');
            if (circuitColumn === -1) {
              circuitColumn = 1; // default to second column if 'circuit' not found
            }
            return line;
          }
          if (microEbusdMode && line && !line.startsWith('#') && !line.startsWith('*')) {
            const parts = line.split(',');
            parts[circuitColumn] = name;
            line = parts.join(',');
          }
          return line.replace(match, name);
        }).join('\n');
        return res(output);
      }
      rej('no output produced');
    } catch (e) {
      rej(`error reading output: ${e}`);
    } finally {
      dispose?.dispose();
    }
  };
  const cmdLine = conversionCmdLine(inFile, outFile, forceConversionOnly);
  if (showOption==='task') {
    const definition: vscode.TaskDefinition = {
      type: 'npm',
      script: 'tsp2ebusd',
      inFile,
      outFile,
    };
    const task = new vscode.Task(definition, vscode.TaskScope.Workspace, 'tsp2ebusd', 'tsp2ebusd',
      new vscode.ShellExecution(cmdLine, {cwd}),
    );
    let execution: vscode.TaskExecution;
    const outputPromise = new Promise<string>((res, rej) => {
      token?.onCancellationRequested(() => {
        execution.terminate();
        dispose.dispose();
        rej('cancelled');
      });
      const dispose = vscode.tasks.onDidEndTask((tsk) => {
        if (!execution || tsk.execution!==execution) {
          return;
        }
        void resolveOutput(res, rej, dispose);
      });
    });
    execution = await vscode.tasks.executeTask(task);
    return outputPromise;
  }
  const hideFromUser = showOption!=='terminal';
  const terminal = vscode.window.createTerminal({cwd, name: 'tsp2ebusd', hideFromUser, isTransient: true});
  disposables?.push(terminal);
  
  const outputPromise = new Promise<string>((res, rej) => {
    let resolved = false;
    let shellIntegration = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code?: number, reason?: vscode.TerminalExitReason, cancelled?: true) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timer) {
        clearTimeout(timer);
      }
      shellListener.dispose();
      closeListener.dispose();
      terminal.dispose();
      if (cancelled) {
        rej('cancelled');
        return;
      }
      const errorMsg = code ? `exited with code ${code}: reason ${reason||'unknown'}` : undefined;
      void resolveOutput(res, rej, undefined, errorMsg);
    };
    token?.onCancellationRequested(() => finish(undefined, undefined, true));
    const closeListener  = vscode.window.onDidCloseTerminal(t => {
      if (t!==terminal) {
        return;
      }
      finish(t.exitStatus?.code, t.exitStatus?.reason);
    });
    const shellListener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal!==terminal || resolved || !e.shellIntegration) {
        return;
      }
      shellIntegration = true;
      if (timer) {
        clearTimeout(timer);
      }
      shellListener.dispose();
      const execution = (terminal.shellIntegration||e.shellIntegration).executeCommand(cmdLine);
      const output = logging ? execution.read() : undefined;
      const endListener = vscode.window.onDidEndTerminalShellExecution(async (event) => {
        if (event.execution!==execution
          // strangely the execution may be different even though the docs recommend doing with ===
          // see also https://github.com/microsoft/vscode/issues/341547
          && event.execution.commandLine.value!==cmdLine
          // at some point, spaces between arguments may be normalized, so check with normalized spaces as well
          && event.execution.commandLine.value.replace(/\s+/g, ' ').trim()!==cmdLine.replace(/\s+/g, ' ').trim()) {
          return;
        }
        endListener.dispose();
        if (output && event.execution===execution) { // see above: if the execution is different, also reading the output never completes
          const chunks: string[] = [];
          for await (const chunk of output) {
            chunks.push(chunk);
          }
          logging!.push(...chunks.join('').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').replace(/\r\n/g, '\n').split('\n'));
        }
        finish(event.exitCode);
      });
    });
    timer = setTimeout(() => {
      if (resolved || shellIntegration) {
        return;
      }
      shellListener.dispose();
      terminal.sendText(cmdLine);
      terminal.sendText('exit');
    }, 2000); // wait up to 2 seconds for shell integration to become ready
  });
  if (!hideFromUser) {
    terminal.show(true);
  }
  return outputPromise;
}

const conversionCmdLine = (inFile: string, outFile: string, forceConversionOnly?: true) => {
  const ebusdCfg = vscode.workspace.getConfiguration('ebus-notebook.ebusd');
  const microEbusd = ebusdCfg.get('micro-ebusd-mode') as 'no'|'yes'|'inline' || 'no';
  const isMicroEbusd = microEbusd && microEbusd!=='no';
  if (isMicroEbusd && !forceConversionOnly && !/^[0-9a-f]{2}[0-9a-zA-Z._]*\./.test(basename(inFile))) {
    throw new Error('invalid input file for micro-ebusd mode, needs to be "ZZ.identifier.*"');
  }
  const isMicroEbusdInline = microEbusd==='inline';
  const target = ebusdCfg.get('host', '')+(isMicroEbusd ? '' : ':'+ebusdCfg.get('port', '8888'));
  const cfg = vscode.workspace.getConfiguration('ebus-notebook.conversion');
  const format = isMicroEbusd && !forceConversionOnly
  ? cfg.get('micro-ebusd-cmd', 'npm exec --package=@ebusd/ebus-typespec tsp2ebusd -- -o ${outFile} -m ${target}${inline} "${inFile}"')
  : cfg.get('cmd', 'npm exec --package=@ebusd/ebus-typespec tsp2ebusd -- -o ${outFile} "${inFile}"');
  return format
  .replace('${inFile}', inFile)
  .replace('${target}', target)
  .replace('${outFile}', outFile)
  .replace('${inline}', isMicroEbusdInline ? ' -i' : ''); // avoid double space in cmdline arg separation
};

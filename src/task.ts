import {readFile, unlink, writeFile} from 'fs/promises';
import {basename, extname, join} from 'path';
import {tmpName} from 'tmp-promise';
import * as vscode from 'vscode';

export type ShowOption = 'terminal'|'task';

export const executeConversion = async (
  cwd: string|undefined, filename: string|undefined, input: string[],
  token?: vscode.CancellationToken, showOption?: ShowOption, 
  disposables?: vscode.Disposable[],
): Promise<string> => {
  const prefix = '_generatedMain_'+(0x1000000+Math.floor(Math.random()*0x1000000)).toString(16).substring(1)+'_';
  let inFile = await tmpName({prefix});
  if (cwd) {
    inFile = join(cwd, basename(inFile)+'.tsp');
  }
  const outFile = await tmpName();
  const enhancedInput = [...input];
  enhancedInput.find((line, idx) => {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('import ') || line.startsWith('using ')) {
      return; // continue
    }
    enhancedInput.splice(idx, 0, 'using Ebus;');
    return true; // give up
  });
  await writeFile(inFile, enhancedInput.join('\n'));
  disposables?.push(vscode.Disposable.from({dispose: () => {
    void unlink(inFile);
    void unlink(outFile);
  }}));
  const resolveOutput = async (res: (value: string) => void, rej: (reason?: any) => void, dispose: vscode.Disposable, failed?: string) => {
    try {
      let output;
      try {
        output = (await readFile(outFile, 'utf-8')).trim();
      } catch (_e) {
        // ignore
      }
      if (failed) {
        return rej(failed+(output ? '\ncommand output:\n'+output:''));
      }
      if (output!==undefined) {
        const match = new RegExp(prefix+'[^,]*');
        let name = 'Main';
        if (filename) {
          filename = basename(filename, extname(filename));
          if (filename) {
            name = filename.substring(0, 1).toUpperCase()+filename.substring(1);
          }
        }
        output = output.split('\n').map(line => line.replace(match, name)).join('\n');
        return res(output);
      }
      rej('no output produced');
    } catch (e) {
      rej(`error reading output: ${e}`);
    } finally {
      dispose.dispose();
    }
  };
  if (showOption==='task') {
    const task = await createTask(inFile, outFile);
    let executionInstance: vscode.TaskExecution;
    const outputPromise = new Promise<string>((res, rej) => {
      token?.onCancellationRequested(() => {
        executionInstance.terminate();
        rej('cancelled');
      });
      const dispose = vscode.tasks.onDidEndTask(async (tsk) => {
        if (!executionInstance || tsk.execution!==executionInstance) {
          return;
        }
        await resolveOutput(res, rej, dispose);
      })
    });
    executionInstance = await vscode.tasks.executeTask(task);
    return await outputPromise;
  }
  const terminal = vscode.window.createTerminal({cwd, name: 'tsp2ebusd', hideFromUser: showOption!=='terminal'});
  disposables?.push(terminal);
  const outputPromise = new Promise<string>((res, rej) => {
    token?.onCancellationRequested(() => {
      terminal.dispose();
      rej('cancelled');
    });
    const dispose = vscode.window.onDidCloseTerminal(async t => {
      if (t!==terminal) {
        return;
      }
      await resolveOutput(res, rej, dispose, t.exitStatus?.code ? `exited with code ${t.exitStatus?.code}: ${t.exitStatus.reason}` : undefined);
    });
  });
  terminal.sendText(conversionCmdLine(inFile, outFile));
  terminal.sendText('exit');
  return await outputPromise;
}

const conversionCmdLine = (inFile: string, outFile: string) => {
  const format = vscode.workspace.getConfiguration('ebus-notebook.conversion').get('cmd', 'npm exec --package=@ebusd/ebus-typespec tsp2ebusd -- -o ${outFile} ${inFile}');
  return format.replace('${inFile}', inFile).replace('${outFile}', outFile);
};

export const createTask = async (inFile: string, outFile: string) => {
  const definition: vscode.TaskDefinition = {
    type: 'npm',
    script: 'tsp2ebusd',
    inFile,
    outFile,
  };
  return new vscode.Task(definition, vscode.TaskScope.Workspace, 'tsp2ebusd', 'tsp2ebusd',
    new vscode.ShellExecution(conversionCmdLine(inFile, outFile)),
  );
}

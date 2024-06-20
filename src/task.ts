import {readFile, unlink, writeFile} from 'fs/promises';
import {tmpName} from 'tmp-promise';
import * as vscode from 'vscode';

export type ShowOption = 'terminal'|'task';

export const executeConversion = async (input: string[], token: vscode.CancellationToken, showOption?: ShowOption, disposables?: vscode.Disposable[]) => {
  const inFile = await tmpName();
  const outFile = await tmpName();
  await writeFile(inFile, input.join('\n'));
  disposables?.push(vscode.Disposable.from({dispose: () => {
    void unlink(inFile);
    void unlink(outFile);
  }}))
  if (showOption==='task') {
    const task = await createTask(inFile, outFile);
    const taskExecution = task.execution! as TspToEbusdExecution;
    let executionInstance: vscode.TaskExecution;
    const outputPromise = new Promise<string>((res, rej) => {
      token.onCancellationRequested(() => rej());
      const dispose = vscode.tasks.onDidEndTask(async (e) => {
        if (executionInstance && e.execution===executionInstance!) {
          const output = await taskExecution.getOutput();
          dispose.dispose();
          res(output);
        }
      })
    });
    executionInstance = await vscode.tasks.executeTask(task);
    return await outputPromise;
  }
  const terminal = vscode.window.createTerminal({name: 'tsp2ebusd', hideFromUser: showOption!=='terminal'});
  disposables?.push(terminal);
  const outputPromise = new Promise<string>((res, rej) => {
    const dispose = vscode.window.onDidCloseTerminal(async t => {
      if (t!==terminal) return;
      if (t.exitStatus?.code) {
        dispose.dispose();
        return rej(`exited with code ${t.exitStatus?.code}: ${t.exitStatus.reason}`);
      }
      const output = (await readFile(outFile, 'utf-8')).trim();
      dispose.dispose();
      res(output);
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
    new TspToEbusdExecution(inFile, outFile),
  );
}

export class TspToEbusdExecution extends vscode.ShellExecution {
  static instances = 0;
  readonly cntr = TspToEbusdExecution.instances++;
  constructor(inFile: string, private outFile: string) {
    super(conversionCmdLine(inFile, outFile));
  }
  getOutput(): Promise<string> {
    return readFile(this.outFile, 'utf-8');
  }
}

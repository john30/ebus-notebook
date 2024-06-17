import {readFile, unlink, writeFile} from 'fs/promises';
import {tmpName} from 'tmp-promise';
import * as vscode from 'vscode';

export const executeConversion = async (input: string[], token: vscode.CancellationToken, asTerminal?: boolean|undefined, disposables?: vscode.Disposable[]) => {
  const inFile = await tmpName();
  const outFile = await tmpName();
  await writeFile(inFile, input.join('\n'));
  disposables?.push(vscode.Disposable.from({dispose: () => {
    void unlink(inFile);
    void unlink(outFile);
  }}))
  if (asTerminal===undefined) {
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
  const terminal = vscode.window.createTerminal({name: 'tsp2ebusd', hideFromUser: asTerminal===false});
  disposables?.push(terminal);
  const outputPromise = new Promise<string>((res, rej) => {
    const dispose = vscode.window.onDidCloseTerminal(async t => {
      if (t!==terminal) return;
      if (t.exitStatus?.code) return rej();
      const output = await readFile(outFile, 'utf-8');
      dispose.dispose();
      res(output);
    });
  });
  terminal.sendText(conversionCmdLine(inFile, outFile));
  terminal.sendText('exit');
  return await outputPromise;
}

const conversionCmdLine = (inFile: string, outFile: string) => `npm exec --package=@ebusd/ebus-typespec tsp2ebusd -- -o ${outFile} ${inFile}`;

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

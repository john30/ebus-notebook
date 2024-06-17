import * as vscode from 'vscode';
import {executeConversion, type ShowOption} from './task.js';
import {createConnection} from 'net';
import {createInterface} from 'readline';


export class Controller {
  private readonly controller: vscode.NotebookController;
  private disposables: vscode.Disposable[] = [];
  private executionOrder = 0;

  constructor() {
    const noteboookType = 'ebus-notebook';
    this.controller = vscode.notebooks.createNotebookController(
      'ebus-notebook-controller-id',
      noteboookType,
      'eBUS Notebook'
    );
    this.controller.supportedLanguages = ['typespec', 'text'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = this.execute.bind(this);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  private async execute(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    const ebusdCfg = vscode.workspace.getConfiguration('ebus-notebook.ebusd');
    const ebusdHostPort: [string, number]|undefined = ebusdCfg.has('host') ? [ebusdCfg.get('host')!, ebusdCfg.get('port')||8888] : undefined;
    const showOptionStr = vscode.workspace.getConfiguration('ebus-notebook.conversion').get('show');
    const showOption: ShowOption|undefined = showOptionStr==='yes' ? 'terminal' : showOptionStr==='task' ? 'task' : undefined;
    cells.forEach(cell => this.executeCell(cell, showOption, ebusdHostPort));
  }
  
  private async executeCell(cell: vscode.NotebookCell, showOption?: ShowOption, ebusdHostPort?: [string, number]): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    let success = false;
    let ebusdInput: string|undefined = undefined;
    let isRaw = false;
    if (cell.document.languageId==='typespec') {
      const disposables: vscode.Disposable[] = [];
      try {
        ebusdInput = await executeConversion([cell.document.getText()], execution.token, showOption, disposables) || '';
        success = true;
      } catch (error) {
        execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error(error as Error)
          ]),
        );
      } finally {
        disposables.forEach(d => d.dispose());
      }
      if (ebusdInput!==undefined) {
        execution.replaceOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(ebusdInput, 'text/csv')
          ])
        );
      }
    } else {
      execution.replaceOutput([]);
      ebusdInput = cell.document.getText() || 'info';
      success = true;
      isRaw = true;
    }
    if (ebusdHostPort) {
      const ebusSuccess = await this.appendEbusdOutput(ebusdHostPort, execution, ebusdInput!.split('\n'), isRaw);
      success = success && ebusSuccess;
    }
    execution.end(success, Date.now());
  }

  private async appendEbusdOutput(ebusdHostPort: [string, number], execution: vscode.NotebookCellExecution, lines: string[], isRaw = false): Promise<boolean> {
    const outLines: string[] = [];
    try {
      await sendToEbusd(lines, ebusdHostPort, (...args) => {
        outLines.push(args.join(' '));
      }, isRaw);
      execution.appendOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.stdout(outLines.join('\n'))
        ])
      );
      return true;
    } catch (error) {
      execution.appendOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.stderr(error instanceof Error ? error.toString() : `${error}`)
        ]),
      );
      return false;
    }
  }
}

const sendToEbusd = async (inputLines: string[], ebusdHostPort: [string, number], log: (...args: any[]) => void, isRaw = false) => {
  // find the relevant line(s) from the output
  let removeLevel: boolean|undefined=undefined;
  const lines=isRaw ? inputLines : inputLines.filter(line => {
    if (removeLevel===undefined) {
      removeLevel=line.includes(',level,');
      return;
    }
    if (!line||line.startsWith('#')||line.startsWith('*')) return;
    return line;
  }).map(line => {
    if (!removeLevel) return line;
    const parts=line.split(',');
    parts.splice(2, 1);
    return parts.join(',');
  }).map(line => `read -V -def "${line}"`);
  if (!lines.length) {
    throw new Error('no usable input');
  }
  const conn=createConnection({port: ebusdHostPort[1], host: ebusdHostPort[0], allowHalfOpen: false});
  conn.setEncoding('utf-8');
  let timer: NodeJS.Timeout|undefined;
  try {
    const send=(): true|undefined => {
      if (timer) {
        clearTimeout(timer);
      }
      const line=lines.shift();
      if (!line) {
        return;
      }
      timer=setTimeout(() => conn.destroy(), 3000);
      log(line);
      conn.write(line+'\n');
      return true;
    };
    send();
    for await (const line of createInterface(conn)) {
      if (!line) {
        if (!send()) {
          break; // end of commands
        }
        continue;
      }
      if (line.startsWith('ERR:')) {
        throw new Error('error from ebusd: '+line);
      }
      log((isRaw?'':'# ')+line);
    }
  } finally {
    try {
      conn.write('\x04');
    } catch (_e) {
      // ignore
    }
    if (timer) {
      clearTimeout(timer);
    }
    conn.destroy();
  }
}

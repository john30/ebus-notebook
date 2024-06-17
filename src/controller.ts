import * as vscode from 'vscode';
import {executeConversion} from './task.js';
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
    this.controller.supportedLanguages = ['typespec', 'json'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = this.execute.bind(this);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  private async execute(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    const settingsFilter = (cell: vscode.NotebookCell) => cell.kind===vscode.NotebookCellKind.Code && cell.document.languageId==='json';
    const settingsCell = cells.find(settingsFilter) || notebook.getCells().find(settingsFilter);;
    const settings = settingsCell && JSON.parse(settingsCell?.document.getText()||'""');
    let ebusdHostPort: [string, number];
    let asTerminal = typeof settings === 'object' ? settings.showTerminal?true:settings.showTerminal===false?undefined:false:false;
    if (typeof settings === 'string' || typeof settings?.ebusd === 'string') {
      const connStr = typeof settings === 'string' ? settings! : settings!.ebusd!;
      const parts = connStr.split(':');
      if (!parts[0].length) {
        throw new Error('invalid ebusd host');
      }
      const ebusdPort = parts.length>1 ? parseInt(parts[1], 10) : 8888;
      if (ebusdPort<1 || ebusdPort>65535 || isNaN(ebusdPort)) {
        throw new Error('invalid ebusd port');
      }
      ebusdHostPort = [parts[0], ebusdPort];
    }
    if (settingsCell && cells.length===1 && cells[0] === settingsCell) {
      // settings only => check connectivity
      const execution = this.controller.createNotebookCellExecution(cells[0]);
      execution.executionOrder = ++this.executionOrder;
      execution.start(Date.now());
      await this.appendEbusdOutput(ebusdHostPort!, execution, ['info'], true);
      execution.end(true, Date.now());
      return;
    }
    cells.filter(cell => cell !== settingsCell).forEach(cell => this.executeCell(cell, asTerminal, ebusdHostPort));
  }
  
  private async executeCell(cell: vscode.NotebookCell, asTerminal?: boolean|undefined, ebusdHostPort?: [string, number]): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    let output: string = '';
    const disposables: vscode.Disposable[] = [];
    let success = false;
    try {
      output = await executeConversion([cell.document.getText()], execution.token, asTerminal, disposables) || '';
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
    execution.replaceOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(output, 'text/csv')
      ])
    );
    if (ebusdHostPort) {
      const ebusSuccess = await this.appendEbusdOutput(ebusdHostPort, execution, output.split('\n'));
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
      log('# '+line);
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

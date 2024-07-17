import {createConnection} from 'net';
import {basename, dirname} from 'path';
import {createInterface} from 'readline';
import * as vscode from 'vscode';
import {executeConversion, type ShowOption} from './task.js';


export class Controller implements vscode.NotebookCellStatusBarItemProvider {
  public ebusdHostPort?: [string, number];
  public readCmd?: string;
  private readonly controller: vscode.NotebookController;
  private disposables: vscode.Disposable[] = [];
  private executionOrder = 0;
  private showOption?: ShowOption;
  private queryInput = false;
  readonly onDidChangeCellStatusBarItems: vscode.Event<void>;

  constructor(context: vscode.ExtensionContext, private outputChannel: vscode.OutputChannel) {
    const noteboookType = 'ebus-notebook';
    this.controller = vscode.notebooks.createNotebookController(
      'ebus-notebook-controller-id',
      noteboookType,
      'eBUS Notebook'
    );
    const eventEmitter = new vscode.EventEmitter<void>();
    context.subscriptions.push(eventEmitter);
    this.onDidChangeCellStatusBarItems = eventEmitter.event;
    this.disposables.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider(noteboookType, this));
    this.controller.supportedLanguages = ['typespec', 'plaintext'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = this.execute.bind(this);
    const updateConfig = () => {
      const showOptionStr = vscode. workspace.getConfiguration('ebus-notebook.conversion').get('show');
      this.showOption = showOptionStr==='yes' ? 'terminal' : showOptionStr==='task' ? 'task' : undefined;
      const ebusdCfg = vscode.workspace.getConfiguration('ebus-notebook.ebusd');
      this.ebusdHostPort = ebusdCfg.has('host') ? [ebusdCfg.get('host')!, ebusdCfg.get('port')||8888] : undefined;
      this.readCmd = ebusdCfg.has('read') ? ebusdCfg.get('read') : undefined;
      if (this.readCmd==='raw' || this.readCmd==='upload') {
        this.readCmd = undefined;
      }
    };
    updateConfig();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('ebus-notebook') && updateConfig()));
    context.subscriptions.push(vscode.commands.registerCommand('ebus-notebook.uploadEbusd', async (...args: any[]) => {
      if (!args.length || args.some(arg => typeof arg !== 'object' || !arg.data || !arg.mime)) {
        await vscode.window.showErrorMessage('Invalid arguments, this command is only useful for notebook cell output.');
        return;
      }
      if (!this.ebusdHostPort) {
        await vscode.window.showErrorMessage('ebusd host/port not defined, please check the settings.');
        return;
      }
      const lineBytes = args.find(i => i.mime==='text/csv')?.data;
      if (!lineBytes?.length) {
        await vscode.window.showErrorMessage('Invalid content, this command is only useful for notebook cell output.');
        return;
      }
      const lines = new TextDecoder().decode(lineBytes).split('\n');
      try {
        let error;
        await sendToEbusd(lines, this.ebusdHostPort, (...args) => {
          if (args.length!==1 || args[0] !== 'done') {
            error = args.join().trim();
          }
        }, 'upload');
        if (error) {
          await vscode.window.showErrorMessage('Error saving to ebusd: '+error);
        } else {
          await vscode.window.showInformationMessage('Uploaded successfully.');
        }
      } catch (e) {
        await vscode.window.showErrorMessage('Error saving to ebusd: '+e);
      }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('ebus-notebook.uploadEbusdToggleInput', () => {
      this.queryInput = !this.queryInput;
      eventEmitter.fire();
    }));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell, token: vscode.CancellationToken): vscode.ProviderResult<vscode.NotebookCellStatusBarItem | vscode.NotebookCellStatusBarItem[]> {
    if (cell.kind!==vscode.NotebookCellKind.Code || cell.document.languageId!=='typespec'
      || !this.ebusdHostPort
    ) {
      return;
    }
    let upload;
    if (cell.executionSummary?.success) {
      upload = new vscode.NotebookCellStatusBarItem('Upload to ebusd', vscode.NotebookCellStatusBarAlignment.Left);
      const tooltip = 'Directly upload the CSV to ebusd so that it gets effective immediately.';
      upload.tooltip = tooltip;
      upload.command = {
        command: 'ebus-notebook.uploadEbusd',
        title: 'upload',
        tooltip,
        arguments: cell.outputs.find(o => o.items.some(i => i.mime==='text/csv'))?.items,
      };
    }
    const toggleInput = new vscode.NotebookCellStatusBarItem('Query user input: '+(this.queryInput?'On':'Off'), vscode.NotebookCellStatusBarAlignment.Left);
    const tooltip='Toggle query for user input.';
    toggleInput.tooltip = tooltip;
    toggleInput.command = {
      command: 'ebus-notebook.uploadEbusdToggleInput',
      title: 'toggle input',
      tooltip,
      arguments: cell.outputs.find(o => o.items.some(i => i.mime==='text/csv'))?.items,
    };
    return upload ? [upload, toggleInput] : toggleInput;
  }

  private async execute(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    cells.forEach(cell => this.executeCell(cell));
  }
  
  private async executeCell(cell: vscode.NotebookCell): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    let success = false;
    let ebusdInput: string|undefined = undefined;
    let isRaw = false;
    execution.replaceOutput([]);
    if (cell.document.languageId==='typespec') {
      const disposables: vscode.Disposable[] = [];
      try {
        ebusdInput = await executeConversion(dirname(cell.document.uri.fsPath), basename(cell.document.uri.fsPath), [cell.document.getText()], execution.token, this.showOption, disposables) || '';
        success = true;
      } catch (error) {
        execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error(error instanceof Error ? error : new Error(error as string))
          ]),
        );
      } finally {
        disposables.forEach(d => d.dispose());
      }
      if (ebusdInput!==undefined) {
        execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(ebusdInput, 'text/csv')
          ])
        );
      }
    } else {
      ebusdInput = cell.document.getText() || 'info';
      success = true;
      isRaw = true;
    }
    if (ebusdInput && this.ebusdHostPort) {
      const ebusSuccess = await this.appendEbusdOutput(this.ebusdHostPort, execution, ebusdInput!.split('\n'), isRaw);
      success = success && ebusSuccess;
    }
    execution.end(success, Date.now());
  }

  private async appendEbusdOutput(ebusdHostPort: [string, number], execution: vscode.NotebookCellExecution, lines: string[], isRaw = false): Promise<boolean> {
    const outLines: string[] = [];
    try {
      const executed = await sendToEbusd(lines, ebusdHostPort, (...args) => {
        this.outputChannel.appendLine(args.join(' '));
        outLines.push(args.join(' '));
      }, isRaw?'raw':this.readCmd, this.queryInput ? execution.token : undefined);
      if (!executed) {
        return false;
      }
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

const filterEbusdLines = (inputLines: string[]) => {
  let removeLevel: boolean|undefined=undefined;
  return inputLines.filter(line => {
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
  });
};

export const sendToEbusd = async (
  inputLines: string[],
  ebusdHostPort: [string, number],
  log: (...args: any[]) => void,
  modeOrFmt?: 'raw'|'upload'|string,
  checkInputToken?: vscode.CancellationToken,
): Promise<boolean> => {
  let lines: string[];
  if (modeOrFmt==='raw') {
    lines = inputLines;
  } else {
    const format = modeOrFmt==='upload'?'define -r "${line}"':(modeOrFmt||'read -V -V -def -def -i "${input}" "${line}"');
    let input: string|undefined = '';
    if (checkInputToken && format.includes('${input}')) {
      // user input is needed
      input = await vscode.window.showInputBox({
        title: 'Provide additional command input',
        placeHolder: 'multiple fields separated by semicolon',
        ignoreFocusOut: true, // needed as otherwise the task view opening asynchronously automatically closes it
      }, checkInputToken);
      if (input === undefined) {
        return false; // no input given
      }
    }
    // filter the relevant line(s) from the conversion output
    lines = filterEbusdLines(inputLines).map(line => format.replace('${line}', line).replace('${input}', input||''));
  }
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
      if (modeOrFmt!=='upload') {
        log(line);
      }
      conn.write(line+'\n');
      return true;
    };
    send();
    const logDirect = modeOrFmt==='raw' || modeOrFmt==='upload';
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
      log((logDirect?'':'# ')+line);
    }
    return true;
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

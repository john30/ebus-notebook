import {createConnection} from 'net';
import {basename, dirname} from 'path';
import {createInterface} from 'readline';
import * as vscode from 'vscode';
import {executeConversion, type ShowOption} from './task.js';


export class Controller implements vscode.NotebookCellStatusBarItemProvider {
  public ebusdHostPort?: [string, number, boolean]; // host, port, isMicroEbusd
  public readCmd?: string;
  private readonly controller: vscode.NotebookController;
  private disposables: vscode.Disposable[] = [];
  private executionOrder = 0;
  public showOption?: ShowOption;
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
      const showOptionStr = vscode.workspace.getConfiguration('ebus-notebook.conversion').get('show');
      this.showOption = showOptionStr==='yes' ? 'terminal' : showOptionStr==='task' ? 'task' : undefined;
      const ebusdCfg = vscode.workspace.getConfiguration('ebus-notebook.ebusd');
      const isMicroEbusd = (ebusdCfg.get('micro-ebusd-mode')||'no')!=='no';
      this.ebusdHostPort = ebusdCfg.has('host') && ebusdCfg.get('host')? [ebusdCfg.get('host')!, ebusdCfg.get('port')||8888, isMicroEbusd] : undefined;
      this.readCmd = ebusdCfg.get(isMicroEbusd?'micro-ebusd-read':'read');
      if (this.readCmd==='raw' || this.readCmd==='upload') {
        this.readCmd = undefined;
      }
    };
    updateConfig();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('ebus-notebook') && updateConfig()));
    context.subscriptions.push(vscode.commands.registerCommand('ebus-notebook.uploadEbusd', async (...args: any[]) => {
      // for micro-ebusd, the first arg needs to be [dirname, basename, typespec]
      const isMicroEbusd = this.ebusdHostPort?.[2];
      if (!args.length
        || args.some((arg, index) =>
          index===0 && isMicroEbusd ? !Array.isArray(arg) || arg.length!==3
          : typeof arg !== 'object' || !arg.data || !arg.mime)) {
        void vscode.window.showErrorMessage('Invalid arguments, this command is only useful for notebook cell output.');
        return;
      }
      if (!this.ebusdHostPort) {
        void vscode.window.showErrorMessage('ebusd host/port not defined, please check the settings.');
        return;
      }
      const outputBytes = args.find((i, index) => (index>0 || !isMicroEbusd) && i.mime==='text/csv')?.data;
      if (!outputBytes?.length) {
        void vscode.window.showErrorMessage('Invalid content, this command is only useful for notebook cell output.');
        return;
      }
      let output: string;
      const tspInput = isMicroEbusd ? args[0][2].split('\n') : undefined;
      if (isMicroEbusd) {
        if (!tspInput) {
          void vscode.window.showErrorMessage('Invalid TypeSpec input for micro-ebusd.');
          return;
        }
        const disposables: vscode.Disposable[] = [];
        const logging: string[] = [];
        try {
          output = await executeConversion(args[0][0], args[0][1], tspInput, undefined, this.showOption, disposables, logging);
        } catch (e) {
          void vscode.window.showErrorMessage('Error saving to micro-ebusd: '+e);
          return;
        } finally {
          if (logging.length) {
            outputChannel.appendLine('conversion log:');
            outputChannel.appendLine(logging.join('\n'));
          }
          disposables.forEach(d => d.dispose());
        }
      } else {
        output = new TextDecoder().decode(outputBytes);
      }
      const target = isMicroEbusd ? 'sending request to micro-ebusd' : 'saving to ebusd';
      const result: string[] = [];
      try {
        let error;
        await sendToEbusd(output.split('\n'), this.ebusdHostPort, (...logArgs) => {
          if (isMicroEbusd) {
            const line = logArgs.join(' ').trim();
            result.push(line);
            outputChannel.appendLine(line);
          } else if (logArgs.length!==1 || logArgs[0] !== 'done') {
            error = logArgs.join().trim();
          }
        }, isMicroEbusd ? this.readCmd : 'upload');
        if (error) {
          throw error;
        } else {
          void vscode.window.showInformationMessage('Uploaded successfully.'+(result.length? ` Result: ${result.join('\n')}` : ''));
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Error ${target}: ${e}`);
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
    if (cell.executionSummary?.success && this.ebusdHostPort) {
      if (this.ebusdHostPort[2]) {
        upload = new vscode.NotebookCellStatusBarItem('Convert+Upload to micro-ebusd', vscode.NotebookCellStatusBarAlignment.Left);
        const tooltip = 'Convert and upload the result to micro-ebusd so that it gets effective immediately.';
        upload.tooltip = tooltip;
        upload.command = {
          command: 'ebus-notebook.uploadEbusd',
          title: 'upload',
          tooltip,
          arguments: [
            [dirname(cell.document.uri.fsPath), basename(cell.document.uri.fsPath), cell.document.getText()],
            ...cell.outputs.find(o => o.items.some(i => i.mime==='text/csv'))?.items||[],
          ],
        };
      } else {
        upload = new vscode.NotebookCellStatusBarItem('Upload to ebusd', vscode.NotebookCellStatusBarAlignment.Left);
        const tooltip = 'Directly upload the conversion result to ebusd so that it gets effective immediately.';
        upload.tooltip = tooltip;
        upload.command = {
          command: 'ebus-notebook.uploadEbusd',
          title: 'upload',
          tooltip,
          arguments: cell.outputs.find(o => o.items.some(i => i.mime==='text/csv'))?.items,
        };
      }
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

  get hideFromUser(): boolean {
    return !this.showOption;
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
      const logging: string[] = [];
      try {
        ebusdInput = await executeConversion(dirname(cell.document.uri.fsPath), basename(cell.document.uri.fsPath), [cell.document.getText()], execution.token, this.showOption, disposables, logging, true) || '';
        success = true;
      } catch (error) {
        execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error(error instanceof Error ? error : new Error(error as string))
          ]),
        );
      } finally {
        if (logging.length) {
          execution.appendOutput(
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.stdout(logging.join('\n'))
            ]),
          );
        }
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
    if (ebusdInput && this.ebusdHostPort && (isRaw || !this.ebusdHostPort[2])) {
      const ebusSuccess = await this.appendEbusdOutput(this.ebusdHostPort, execution, ebusdInput!.split('\n'), isRaw);
      success = success && ebusSuccess;
    }
    execution.end(success, Date.now());
  }

  private async appendEbusdOutput(ebusdHostPort: [string, number, boolean], execution: vscode.NotebookCellExecution, lines: string[], isRaw = false): Promise<boolean> {
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

export const filterEbusdLines = (inputLines: string[], keepColumnDef?: true) => {
  let removeLevel: boolean|undefined=undefined;
  return inputLines.filter(line => {
    if (removeLevel===undefined) {
      removeLevel=line.includes(',level,');
      return keepColumnDef;
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
  ebusdHostPort: [string, number, boolean],
  log: (...args: any[]) => void,
  modeOrFmt?: 'raw'|'upload'|string,
  checkInputToken?: vscode.CancellationToken,
): Promise<boolean> => {
  let lines: string[];
  const queryInput = async (): Promise<string|undefined> =>
    vscode.window.showInputBox({
      title: 'Provide additional command input',
      placeHolder: 'multiple fields separated by semicolon',
      ignoreFocusOut: true, // needed as otherwise the task view opening asynchronously automatically closes it
    }, checkInputToken);
  const isMicroEbusd = ebusdHostPort[2];
  if (modeOrFmt==='raw') {
    lines = inputLines;
  } else if (isMicroEbusd && modeOrFmt==='upload') {
    return true; // for micro-ebusd the upload is done by tsp2ebusd itself
  } else {
    const format = modeOrFmt==='upload'
    ? 'define -r "${line}"'
    : (modeOrFmt || (isMicroEbusd
      ? 'read -v -i "${input}" -c "${circuit}" "${name}"'
      : 'read -V -V -def -def -i "${input}" "${line}"'));
    let input: string|undefined = '';
    if (checkInputToken && format.includes('${input}')) {
      // user input is needed
      input = await queryInput();
      if (input === undefined) {
        return false; // no input given
      }
    }
    // filter the relevant line(s) from the conversion output
    lines = filterEbusdLines(inputLines).map(line => {
      let result = format;
      if (isMicroEbusd) {
        const parts = line.split(',');
        result = result
        .replace('${circuit}', parts[1])
        .replace('${name}', parts[2]);
      } else {
        result = result
        .replace('${line}', line);
      }
      return result
      .replace('${input}', input||'');
    });
  }
  if (!lines.length) {
    throw new Error('no usable input');
  }
  if (isMicroEbusd) {
    let firstWait = !modeOrFmt && isMicroEbusd;
    for (const line of lines) {
      if (firstWait && line.startsWith('read ')) {
        firstWait = false;
        // give micro-ebusd some time for the reload
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await sendMicroEbusdRepl(line, ebusdHostPort[0], log);
    }
    return true;
  }
  return await uploadToEbusdRepl(lines, ebusdHostPort[0], ebusdHostPort[1], log, modeOrFmt);
}

const uploadToEbusdRepl = async (
  lines: string[],
  host: string, port: number,
  log: (...args: any[]) => void,
  modeOrFmt?: 'raw'|'upload'|string,
): Promise<boolean> => {
  const conn=createConnection({port, host, allowHalfOpen: false});
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


const fetchTimeout = async <T>(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  timeout: number,
  handler: (response: Response) => Promise<T>,
): Promise<T> => {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort('request timed out');
  }, timeout);
  try {
    const response = await fetch(input, {...init, signal: abort.signal});
    return await handler(response);
  } finally {
    clearTimeout(timer);
  }
};

const sendMicroEbusdRepl = async (
  line: string,
  hostOrUrl: string,
  log: (...args: any[]) => void,
): Promise<void> => {
  if (!hostOrUrl.startsWith('http') || !hostOrUrl.includes('://')) {
    hostOrUrl = 'http://'+hostOrUrl;
  }
  const api = new URL(hostOrUrl);
  const headers = api.username ? {Authorization: 'Basic '+Buffer.from(api.username+':'+(api.password??'')).toString('base64')} : undefined;
  api.pathname = '/api/v1/repl';
  api.username = '';
  api.password = '';
  await fetchTimeout(api, {method: 'PUT', body: line, headers}, 3000, async (ret) => {
    try {
      let error: string|undefined = undefined;
      if (ret.ok) {
        const data = await ret.json() as {entries?: {log?: string, severity?: 1|2|3}[]};
        data.entries?.map(entry => {
          if (entry.severity===1) {
            error = entry.log; // pick the last error line
          }
          log(entry.log);
        });
        if (error) {
          throw error;
        }
        return;
      }
      let body: string = '';
      try {
        body = await ret.text()
      } catch (_) {
        // ignore
      }
      throw new Error(`command failed: ${ret.status} ${ret.statusText} ${body}`);
    } catch (e) {
      throw new Error(`command failed: ${e}`);
    }
  });
};

import * as vscode from 'vscode';
import {Controller} from './controller.js';
import {Serializer} from './serializer.js';
import {executeConversion} from './task.js';

const CMD_CREATE_FILE = 'ebus-notebook.createFile';
const CMD_CREATE_NOTEBOOK = 'ebus-notebook.createNotebook';
const CMD_CONVERT = 'ebus-notebook.convert';

const outputChannel = vscode.window.createOutputChannel('eBUS Notebook');

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('ebus-notebook', new Serializer())
  );
  context.subscriptions.push(vscode.commands.registerCommand(CMD_CREATE_FILE, async (...args: any[]) => {
    const content = (args?.length ? args.map(arg => `${arg}`) : [
      'import "@ebusd/ebus-typespec";',
      'using Ebus;',
      '',
      '/** <describe the circuit here>. */',
      '@zz(0x75) // <= the address of the circuit',
      'namespace circuitname { // <= use a name here matching the result of the scan',
      '  /** <describe the message here>. */',
      '  @id(0xb5, 0x09, 0x0d, 0x00, 0x00) // <= the ID of the message, e.g. \'b509 0d0000\'',
      '  model messagename { // <= use a name here giving a hint to what the message contains',
      '    /** <describe the value here>. */',
      '    value: num.UCH, // <= for single-value messages, use \'value\', otherwise give it a speaking name, e.g. \'temperature\'',
      '  }',
      '}',
    ]).join('\n');
		const doc = await vscode.workspace.openTextDocument({language: 'typespec', content});
		await vscode.window.showTextDocument(doc);
    outputChannel.appendLine('created eBUS TypeSpec file');
	}));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_CREATE_NOTEBOOK, async (...args: any[]) => {
    const src = args?.length===1 ? `${args[0]}` : '';
		const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, src, 'typespec')]);
		const doc = await vscode.workspace.openNotebookDocument('ebus-notebook', data);
		await vscode.window.showNotebookDocument(doc);
    outputChannel.appendLine('created eBUS notebook');
	}));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_CONVERT, async (...args: any[]) => {
    const src = args?.length===1 ? `${args[0]}` : '';
    const disposables: vscode.Disposable[] = [];
    vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Converting', cancellable: true}, async (progress, token) => {
      try {
        const output = await executeConversion([src], token, undefined, disposables) || '';
        outputChannel.appendLine('conversion result:');
        outputChannel.show();
        outputChannel.append(output);
      } catch (error) {
        outputChannel.append('conversion error:');
        outputChannel.show();
        outputChannel.append(`${error}`);
      } finally {
        disposables.forEach(d => d.dispose());
      }
    });
	}));
  context.subscriptions.push(new Controller(context, outputChannel));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({language: 'typespec'}, new CodeActionProvider(), {providedCodeActionKinds: [vscode.CodeActionKind.Empty]}));
}

export function deactivate() {}

class CodeActionProvider implements vscode.CodeActionProvider<vscode.CodeAction> {
  public async provideCodeActions(
    document: vscode.TextDocument, range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext, token: vscode.CancellationToken):
    Promise<vscode.CodeAction[]> {
    const syms = (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)) as (vscode.SymbolInformation|vscode.DocumentSymbol)[];
    const sym = syms.find(sym => sym instanceof vscode.SymbolInformation && sym.location.range.contains(range)) as vscode.SymbolInformation;
    if (!sym) {
      return [];
    }
    const txt = document.getText(sym.location.range);
    const notebookAction = new vscode.CodeAction('Create eBUS Notebook from this...', vscode.CodeActionKind.Empty);
    notebookAction.command = {command: CMD_CREATE_NOTEBOOK, title: 'Create eBUS Notebook', tooltip: 'Creates an eBUS Notebook from this.', arguments: [txt]};
    const convertAction = new vscode.CodeAction('Convert to eBUS CSV...', vscode.CodeActionKind.Empty);
    convertAction.command = {command: CMD_CONVERT, title: 'Convert eBUS CSV', tooltip: 'Converts file to eBUS CSV.', arguments: [txt]};
    return [
      notebookAction,
      convertAction,
    ];
  }
}

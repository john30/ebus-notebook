import * as vscode from 'vscode';
import {Serializer} from './serializer.js';
import {Controller} from './controller.js';

const CMD_CREATE_FILE = 'ebus-notebook.createFile';
const CMD_CREATE_NOTEBOOK = 'ebus-notebook.createNotebook';

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
	}));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_CREATE_NOTEBOOK, async (...args: any[]) => {
    const src = args?.length===1 ? `${args[0]}` : '';
		const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, src, 'typespec')]);
		const doc = await vscode.workspace.openNotebookDocument('ebus-notebook', data);
		await vscode.window.showNotebookDocument(doc);
	}));
  context.subscriptions.push(new Controller(context));
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
    notebookAction.command = {command: CMD_CREATE_NOTEBOOK, title: 'Create eBUS Notebook', tooltip: 'Creates an eBUS Notebook from this symbol.', arguments: [txt]};
    return [
      notebookAction,
    ];
  }
}

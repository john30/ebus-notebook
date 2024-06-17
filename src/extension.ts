import * as vscode from 'vscode';
import {Serializer} from './serializer.js';
import {Controller} from './controller.js';

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('ebus-notebook', new Serializer())
  );
  context.subscriptions.push(vscode.commands.registerCommand('ebus-notebook.createNotebook', async () => {
		const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'typespec')]);
		const doc = await vscode.workspace.openNotebookDocument('ebus-notebook', data);
		await vscode.window.showNotebookDocument(doc);
	}));
  context.subscriptions.push(new Controller());
}

export function deactivate() {}


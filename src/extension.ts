import * as vscode from 'vscode';
import {Serializer} from './serializer.js';
import {Controller} from './controller.js';

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('ebus-notebook', new Serializer())
  );
  context.subscriptions.push(new Controller());
}

export function deactivate() {}


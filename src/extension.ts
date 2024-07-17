import {dirname} from 'path';
import * as vscode from 'vscode';
import {Controller, sendToEbusd} from './controller.js';
import {Serializer} from './serializer.js';
import {executeConversion} from './task.js';

const CMD_CREATE_FILE = 'ebus-notebook.createFile';
const CMD_CREATE_NOTEBOOK = 'ebus-notebook.createNotebook';
const CMD_CONVERT = 'ebus-notebook.convert';
const CMD_CONVERT_AND_TEST = 'ebus-notebook.convertAndTest';


export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('eBUS Notebook');

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
      '    value: Num.UCH, // <= for single-value messages, use \'value\', otherwise give it a speaking name, e.g. \'temperature\'',
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
  const controller = new Controller(context, outputChannel);
  const convertCmd = async (test: string[]|undefined, ...args: any[]): Promise<void> => {
    let needsInput = false;
    if (args.length>1 && args[0]==='-i') {
      needsInput = true;
      args.splice(0, 1);
    }
    const src = args?.length===1 ? `${args[0]}` : '';
    const disposables: vscode.Disposable[] = [];
    let uri = vscode.window.activeTextEditor?.document.uri;
    let cwd = uri ? dirname(uri.fsPath) : undefined;
    if (!cwd || cwd === '.') {
      uri = vscode.window.activeNotebookEditor?.notebook.uri;
      cwd = uri ? dirname(uri.fsPath) : undefined;
    }
    if (!cwd || cwd === '.') {
      uri = vscode.workspace.workspaceFile;
      cwd = uri ? dirname(uri.fsPath) : undefined;
    }
    if (!cwd || cwd === '.') {
      uri = vscode.workspace.workspaceFolders?.[0]?.uri;
      cwd = uri?.fsPath;
    }
    vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Converting', cancellable: true}, async (progress, token): Promise<void> => {
      let output: string;
      try {
        output = await executeConversion(cwd, undefined, [src], token, undefined, disposables) || '';
        outputChannel.appendLine('conversion result:');
        outputChannel.show();
        outputChannel.appendLine(output);
      } catch (error) {
        outputChannel.append('conversion error:');
        outputChannel.show();
        outputChannel.appendLine(`${error}`);
        return;
      } finally {
        disposables.forEach(d => d.dispose());
      }
      if (token.isCancellationRequested) {
        return;
      }
      progress.report({message: 'conversion done'});
      if (test?.length && output && controller.ebusdHostPort) {
        const lines = output.split('\n');
        const name = test[test.length-1].toLowerCase();
        const namespaces = test.slice(0, test.length-1).map(n => n.toLowerCase()).filter(n=>n);
        let found = false;
        let foundMain = '';
        const picked = lines.filter((line, index) => {
          if (index===0 || line.startsWith('#') || line.startsWith('*')) return true;
          if (found) return false;
          const parts = line.split(',').slice(1, 4); // type, circuit, level, name
          if (parts[2]?.toLowerCase() !== name) {
            return false;
          }
          found = namespaces.includes(parts[0].toLowerCase());
          if (!found && parts[0] === 'Main') {
            foundMain = line;
          }
          return found;
        });
        if (!found && foundMain) {
          // fallback added by executeConversion in absence of filename
          picked.push(foundMain);
          found = true;
        }
        if (!found) {
          outputChannel.appendLine('model '+test.join('/')+' not found in conversion result');
          return;
        }
        outputChannel.appendLine('ebusd result:');
        try {
          const executed = await sendToEbusd(picked, controller.ebusdHostPort, (...args) => {
            outputChannel.appendLine(args.join(' '));
          }, controller.readCmd, needsInput?token:undefined);
          if (!executed) {
            outputChannel.appendLine('aborted');
            return;
          }
          outputChannel.appendLine('done');
        } catch (error) {
          outputChannel.appendLine(
            'error: '+(error instanceof Error ? error.toString() : `${error}`)
          );
        }
      }
    });
	};
  context.subscriptions.push(vscode.commands.registerCommand(CMD_CONVERT, async (...args: any[]) => convertCmd(undefined, ...args)));
  context.subscriptions.push(vscode.commands.registerCommand(CMD_CONVERT_AND_TEST, async (...args: any[]) => convertCmd(args[0], ...args.slice(1))));
  context.subscriptions.push(controller);
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({language: 'typespec'}, new CodeActionProvider(), {providedCodeActionKinds: [vscode.CodeActionKind.Empty]}));
}

export function deactivate() {}

class CodeActionProvider implements vscode.CodeActionProvider<vscode.CodeAction> {
  public async provideCodeActions(
    document: vscode.TextDocument, range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext, token: vscode.CancellationToken):
    Promise<vscode.CodeAction[]> {
    const syms = (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)) as vscode.SymbolInformation[]|vscode.DocumentSymbol[];
    type Match = {name: string, range: vscode.Range, kind: vscode.SymbolKind}[];
    let match: Match = [];
    if (syms) {
      // weird as sym being instanceof SymbolInformation may have children nevertheless
      const hasChildren = (sym: vscode.SymbolInformation | vscode.DocumentSymbol): sym is vscode.DocumentSymbol => (sym as vscode.DocumentSymbol).children?.length>0;
      const traverse = (syms: vscode.SymbolInformation[] | vscode.DocumentSymbol[], stack: Match=[]) => {
        for (const sym of syms) {
          let r: vscode.Range;
          const isd = sym instanceof vscode.DocumentSymbol;
          if (sym instanceof vscode.SymbolInformation) {
            r = sym.location.range;
          } else {
            r = sym.range;
          }
          const childStack = [...stack];
          if (r.contains(range) || sym.kind===vscode.SymbolKind.Namespace) {
            childStack.push({name: sym.name, range: r, kind: sym.kind});
            if (sym.kind===vscode.SymbolKind.Struct) {
              match = childStack; // could break here, but keep on going for finding most concrete match of all
            }
          }
          if (hasChildren(sym)) {
            traverse(sym.children, childStack)
          }
        }
      }
      traverse(syms);
    }
    if (!match.length) {
      return [];
    }
    const allTxt = document.getText();
    const modelTxt = document.getText(match[match.length-1].range);
    const notebookModelAction = new vscode.CodeAction('Create eBUS Notebook from this model...', vscode.CodeActionKind.Empty);
    notebookModelAction.command = {command: CMD_CREATE_NOTEBOOK, title: 'Create eBUS Notebook from model', arguments: [modelTxt]};
    const notebookAction = new vscode.CodeAction('Create eBUS Notebook from this file...', vscode.CodeActionKind.Empty);
    notebookAction.command = {command: CMD_CREATE_NOTEBOOK, title: 'Create eBUS Notebook from file', arguments: [allTxt]};
    const convertTestAction = new vscode.CodeAction('Convert model to eBUS CSV and test...', vscode.CodeActionKind.Empty);
    convertTestAction.command = {command: CMD_CONVERT_AND_TEST, title: 'Convert model to eBUS CSV and test', arguments: [match.map(m=>m.name), allTxt]};
    const convertTestActionInput = new vscode.CodeAction('Convert model to eBUS CSV and test with user input...', vscode.CodeActionKind.Empty);
    convertTestActionInput.command = {command: CMD_CONVERT_AND_TEST, title: 'Convert model to eBUS CSV and test with user input', arguments: [match.map(m=>m.name), '-i', allTxt]};
    const convertAction = new vscode.CodeAction('Convert file to eBUS CSV...', vscode.CodeActionKind.Empty);
    convertAction.command = {command: CMD_CONVERT, title: 'Convert to eBUS CSV', arguments: [allTxt]};
    return [
      convertTestAction,
      convertTestActionInput,
      convertAction,
      notebookModelAction,
      notebookAction,
    ];
  }
}

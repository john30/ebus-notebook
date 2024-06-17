import * as vscode from 'vscode';

interface RawNotebook {
  cells: RawNotebookCell[];
}

interface RawNotebookCell {
  source: string[];
  type: 'typespec'|'json'|'markdown';
  outputs?: string[][],
  success?: boolean,
}

export class Serializer implements vscode.NotebookSerializer {
  async deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken
  ): Promise<vscode.NotebookData> {
    var contents=new TextDecoder().decode(content);

    let raw: RawNotebookCell[];
    try {
      raw=(<RawNotebook>JSON.parse(contents)).cells;
    } catch {
      raw=[];
    }

    const cells=(raw||[]).map(item => {
      const data = new vscode.NotebookCellData(
        item.type==='markdown'
          ? vscode.NotebookCellKind.Markup
          : vscode.NotebookCellKind.Code,
        item.source.join('\n'),
        item.type==='typespec' ? 'typespec'
          : item.type==='json' ? 'json' : 'markdown',
      );
      if (item.outputs?.length) {
        data.outputs = item.outputs.map(o => new vscode.NotebookCellOutput(o.map(i =>
          vscode.NotebookCellOutputItem.text(i))))
      }
      if (item.success!==undefined) {
        data.executionSummary = {success: item.success};
      }
      return data;
    });

    return new vscode.NotebookData(cells);
  }

  async serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken
  ): Promise<Uint8Array> {
    let contents: RawNotebookCell[]=[];
    const decoder = new TextDecoder();
    for (const cell of data.cells) {
      contents.push({
        type: cell.kind===vscode.NotebookCellKind.Code ? cell.languageId==='typespec' ? 'typespec' : 'json' : 'markdown',
        source: cell.value.split(/\r?\n/g),
        outputs: cell.outputs?.map(o => o.items.map(i => decoder.decode(i.data))),
        success: cell.executionSummary?.success,
      });
    }
    return new TextEncoder().encode(JSON.stringify({cells: contents}));
  }
}

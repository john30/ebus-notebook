import * as vscode from 'vscode';

interface RawNotebook {
  cells: RawNotebookCell[];
}

interface RawNotebookCell {
  source: string[];
  type: 'typespec'|'text'|'markdown';
  outputs?: Record<string, string[]>[],
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
          : item.type==='text' ? 'plaintext' : 'markdown',
      );
      if (item.outputs?.length) {
        data.outputs = item.outputs.map(o => new vscode.NotebookCellOutput(Object.entries(o).map(([m,l]) =>
          vscode.NotebookCellOutputItem.text(l.join('\n'), m))))
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
        type: cell.kind===vscode.NotebookCellKind.Code
          ? cell.languageId==='typespec' ? 'typespec' : 'text'
          : 'markdown',
        source: cell.value.split(/\r?\n/g),
        outputs: cell.outputs?.map(o => o.items.reduce((p, c) => {
          p[c.mime] = decoder.decode(c.data).split('\n');
          return p;
        }, {} as Record<string, string[]>)),
        success: cell.executionSummary?.success,
      });
    }
    return new TextEncoder().encode(JSON.stringify({cells: contents}));
  }
}

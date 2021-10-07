'use strict';
import * as path from 'path';
import {
    LanguageClient, LanguageClientOptions, ServerOptions,
    TransportKind
} from 'vscode-languageclient';
import { lintAndfixCurrentDocument } from './linter/soliumClientFixer';
import { toggleFileExtension } from './toggleFileExtension';

// tslint:disable-next-line:no-duplicate-imports
import {
    workspace, ExtensionContext, DiagnosticCollection,
    languages, commands
} from 'vscode';

let diagnosticCollection: DiagnosticCollection;
let clientDisposable: LanguageClient;

export async function activate(context: ExtensionContext) {
    const ws = workspace.workspaceFolders;
    diagnosticCollection = languages.createDiagnosticCollection('tonsolidity');

    context.subscriptions.push(diagnosticCollection);

    context.subscriptions.push(commands.registerCommand('tonsolidity.fixDocument', () => {
        lintAndfixCurrentDocument();
    }));

    context.subscriptions.push(commands.registerCommand('tonsolidity.toggleFileExtension', (event) => {
        const rootDir = path.dirname(event.fsPath).replace(workspace.workspaceFolders?.[0].uri.fsPath, "").substr(1);
        toggleFileExtension(rootDir);
    }));
    
    const serverModule = path.join(__dirname, './server.js');

    const serverOptions: ServerOptions = {
        debug: {
            module: serverModule,
            options: {
                execArgv: ['--nolazy', '--inspect=6010'],
            },
            transport: TransportKind.ipc,
        },
        run: {
            module: serverModule,
            transport: TransportKind.ipc,
        },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'tonsolidity', scheme: 'file' },
            { language: 'tonsolidity', scheme: 'untitled' },
        ],
        synchronize: {
            // Synchronize the setting section 'tonsolidity' to the server
            configurationSection: 'tonsolidity',
        },
        initializationOptions: context.extensionPath,
    };

    if (ws) {
        clientDisposable = new LanguageClient(
            'tonsolidity',
            'TON Solidity Language Server',
            serverOptions,
            clientOptions);

        clientDisposable.onDidChangeState((data: any) => {
            console.log(`State event received: ${JSON.stringify(data)}`);
        });

        clientDisposable.start();
    }
}

export function deactivate(): Thenable<void> | undefined {
    if (!clientDisposable) {
        return undefined;
    }
    return clientDisposable.stop();
}
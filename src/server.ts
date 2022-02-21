'use strict';
import * as fs from 'fs';
import * as path from 'path';
import {
    createConnection, Connection,
    IPCMessageReader, IPCMessageWriter,
    TextDocuments, InitializeResult, Hover,
    Files, Diagnostic, TextDocumentPositionParams,
    CompletionItem, Location, SignatureHelp,
    TextDocumentSyncKind, HoverParams, MarkedString
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Linter from './linter/linter';
import SolhintService from './linter/solhint';
import SoliumService from './linter/solium';
import { CompilerError } from './solErrorsToDiagnostics';
import { CompletionService } from './completionService';
import { SolidityDefinitionProvider } from './definitionProvider';
import { HoverService } from './hoverService';
import { SolcCompiler } from './solcCompiler';

interface Settings {
    tonsolidity: SoliditySettings;
}

interface SoliditySettings {
    // option for backward compatibilities, please use "linter" option instead
    linter: boolean | string;
    enabledAsYouTypeCompilationErrorCheck: boolean;
    nodemodulespackage: string;
    soliumRules: any;
    solhintRules: any;
    defaultCompiler: string;
    compileUsingLocalVersion: string;
    validationDelay: number;
    packageDefaultDependenciesDirectory: string;
    packageDefaultDependenciesContractsDirectory: string;
}

// import * as path from 'path';
// Create a connection for the server
const connection: Connection = createConnection(
    new IPCMessageReader(process),
    new IPCMessageWriter(process));

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);
const documents = new TextDocuments(TextDocument);

let rootPath: string;
let linter: Linter = null;
let solcCompiler: SolcCompiler;

let enabledAsYouTypeErrorCheck = false;
let solhintDefaultRules = {};
let soliumDefaultRules = {};
let validationDelay = 1500;

// flags to avoid trigger concurrent validations (compiling is slow)
let validatingDocument = false;
let validatingAllDocuments = false;
let packageDefaultDependenciesDirectory = 'lib';
let packageDefaultDependenciesContractsDirectory = 'src';

async function validate(document) {
    try {
        validatingDocument = true;
        const uri = document.uri;
        const filePath = Files.uriToFilePath(uri);

        const documentText = document.getText();
        let linterDiagnostics: Diagnostic[] = [];
        const compileErrorDiagnostics: Diagnostic[] = [];
        try {
            if (linter !== null) {
                linterDiagnostics = linter.validate(filePath, documentText);
            }
        } catch {
            // gracefull catch
        }

        try {
            if (enabledAsYouTypeErrorCheck) {
                const errors: CompilerError[] = await solcCompiler
                    .compileSolidityDocumentAndGetDiagnosticErrors(filePath, documentText,
                                                packageDefaultDependenciesDirectory,
                                                packageDefaultDependenciesContractsDirectory);
                errors.forEach(errorItem => {
                    const currentFileName = path.basename(filePath);
                    if (errorItem.fileName === currentFileName) {
                        compileErrorDiagnostics.push(errorItem.diagnostic);
                    }
                });
            }
        } catch (e) {
            //console.log(JSON.stringify(e));
        }

        const diagnostics = linterDiagnostics.concat(compileErrorDiagnostics);
        connection.sendDiagnostics({diagnostics, uri});
    } finally {
        validatingDocument = false;
    }
}

connection.onSignatureHelp((): SignatureHelp => {
    return null;
});

// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    let completionItems = [];
    const document = documents.get(textDocumentPosition.textDocument.uri);
    const service = new CompletionService(rootPath);

    completionItems = completionItems.concat(
        service.getAllCompletionItems2( packageDefaultDependenciesDirectory,
                                        packageDefaultDependenciesContractsDirectory,
                                        document,
                                        textDocumentPosition.position,
                                        )
    );
    return completionItems;
});

connection.onHover((textPosition: HoverParams): Hover => {
    const hoverService = new HoverService(rootPath);
    const suggestion = hoverService.getHoverItems(
        packageDefaultDependenciesDirectory,
        packageDefaultDependenciesContractsDirectory,
        documents.get(textPosition.textDocument.uri),
        textPosition.position);
    let doc : MarkedString[] = suggestion
    return {
      contents: doc
    }
});

connection.onDefinition((handler: TextDocumentPositionParams): Thenable<Location | Location[]> => {
    const provider = new SolidityDefinitionProvider(
        rootPath,
        packageDefaultDependenciesDirectory,
        packageDefaultDependenciesContractsDirectory,
    );
    return provider.provideDefinition(documents.get(handler.textDocument.uri), handler.position);
});

// This handler resolve additional information for the item selected in
// the completion list.
 // connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
 //   item.
 // });
function validateAllDocuments() {
    if (!validatingAllDocuments) {
        try {
            validatingAllDocuments = true;
            documents.all().forEach(document => validate(document));
        } finally {
            validatingAllDocuments = false;
        }
    }
}

function startValidation() {
    if (enabledAsYouTypeErrorCheck) {
        validateAllDocuments();
    } else {
        //console.log('error check on typing is disabled');
    }
}

documents.onDidOpen(event => {
    const document = event.document;

    if (!validatingDocument && !validatingAllDocuments) {
        validate(document);
    }
});

documents.onDidChangeContent(event => {
    const document = event.document;

    if (!validatingDocument && !validatingAllDocuments) {
        validatingDocument = true; // control the flag at a higher level
        // slow down, give enough time to type (1.5 seconds?)
        setTimeout(() =>  validate(document), validationDelay);
    }
});

documents.onDidSave(event => {
    removeTmpFiles(event);
});

// remove diagnostics from the Problems panel when we close the file
documents.onDidClose(event => {
    connection.sendDiagnostics({
        diagnostics: [],
        uri: event.document.uri,
    });
    removeTmpFiles(event);
});

function removeTmpFiles(event) {
    const fileNameId = Files.uriToFilePath(event.document.uri);
    let fileDir = path.dirname(fileNameId);
        fileDir = fileDir.replace(/\/contracts\//, "/.temp/");
        fileDir = fileDir.replace(/\\contracts\\/, "\\.temp\\");
        fileDir = fileDir.replace(/\/contracts$/, "/.temp");
        fileDir = fileDir.replace(/\\contracts$/, "\\.temp");

    let fileDirBuild = path.dirname(fileNameId);
        fileDirBuild = fileDirBuild.replace(/\/contracts\//, "/build/");
        fileDirBuild = fileDirBuild.replace(/\\contracts\\/, "\\build\\");
        fileDirBuild = fileDirBuild.replace(/\/contracts$/, "/build");
        fileDirBuild = fileDirBuild.replace(/\\contracts$/, "\\build");
    const fileName  = path.basename(fileNameId);
    const tmpFileName  = path.resolve(fileDir, "~" + fileName);
    if (fs.existsSync(tmpFileName)) {
        fs.unlink(tmpFileName, (error) => {
            if (error != null) {
                console.error(JSON.stringify(error));
            }
        });
    }
    if (fs.existsSync(tmpFileName.replace(/\.[^/.]+$/, ".tvc"))) {
        if (!fs.existsSync(fileDirBuild)) {
            fs.mkdirSync(fileDirBuild, { recursive: true });
        }
        fs.renameSync(tmpFileName.replace(/\.[^/.]+$/, ".tvc"),
            path.resolve(fileDirBuild, fileName.replace(/\.[^/.]+$/, ".tvc"))
        );
        const contentTvc = fs.readFileSync(path.resolve(fileDirBuild, fileName.replace(/\.[^/.]+$/, ".tvc")));
        fs.writeFileSync(path.resolve(fileDirBuild, fileName.replace(/\.[^/.]+$/, ".base64")), Buffer.from(contentTvc).toString('base64'));
    }

    if (fs.existsSync(tmpFileName.replace(/\.[^/.]+$/, ".abi.json"))) {
        if (!fs.existsSync(fileDirBuild)) {
            fs.mkdirSync(fileDirBuild, { recursive: true });
        }
        fs.renameSync(tmpFileName.replace(/\.[^/.]+$/, ".abi.json"),
            path.resolve(fileDirBuild, fileName.replace(/\.[^/.]+$/, ".abi.json"))
        );
    }
}

connection.onInitialize((result): InitializeResult => {
    rootPath = result.rootPath;
    solcCompiler = new SolcCompiler(rootPath);
    return {
        capabilities: {
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: [ '.' ],
            },
            hoverProvider: true,
            definitionProvider: true,
            textDocumentSync: TextDocumentSyncKind.Full,
        },
    };
});

connection.onInitialized(() => {
    console.log('TON solidity language server is created.');
});

connection.onDidChangeConfiguration((change) => {
    const settings = <Settings>change.settings;
    enabledAsYouTypeErrorCheck = settings.tonsolidity.enabledAsYouTypeCompilationErrorCheck;
    solhintDefaultRules = settings.tonsolidity.solhintRules;
    soliumDefaultRules = settings.tonsolidity.soliumRules;
    validationDelay = settings.tonsolidity.validationDelay;
    packageDefaultDependenciesContractsDirectory = settings.tonsolidity.packageDefaultDependenciesContractsDirectory;
    packageDefaultDependenciesDirectory = settings.tonsolidity.packageDefaultDependenciesDirectory;

    switch (linterName(settings.tonsolidity)) {
        case 'solhint': {
            linter = new SolhintService(rootPath, solhintDefaultRules);
            break;
        }
        case 'solium': {
            linter = new SoliumService(rootPath, soliumDefaultRules, connection);
            break;
        }
        default: {
            linter = null;
        }
    }

    if (linter !== null) {
        linter.setIdeRules(linterRules(settings.tonsolidity));
    }

    startValidation();
});

function linterName(settings: SoliditySettings) {
     return settings.linter;
}

function linterRules(settings: SoliditySettings) {
    const _linterName = linterName(settings);
    if (_linterName === 'solium') {
        return settings.soliumRules;
    } else {
        return settings.solhintRules;
    }
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

connection.listen();

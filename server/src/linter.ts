/* eslint-disable eqeqeq */
import { TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';

import { DocumentsManager } from './DocumentsManager';
import { applyTextDocumentEditOnWorkspace, getUpdatedSource, createTextEdit, notifyFixFailures } from './clientUtils';
import { parseLinterResults } from './linterParser';
import { StatusNotification, OpenNotification } from './types';
import { ShowMessageRequestParams, MessageType } from 'vscode-languageserver';
import { COMMAND_LINT_FIX } from './commands';
const NpmGroovyLint = require("npm-groovy-lint/jdeploy-bundle/groovy-lint.js");
const debug = require("debug")("vscode-groovy-lint");
const { performance } = require('perf_hooks');

// Validate a groovy file (just lint, or also format or fix)
export async function executeLinter(textDocument: TextDocument, docManager: DocumentsManager, opts: any = { fix: false, format: false, showDocumentIfErrors: false, force: false }): Promise<TextEdit[]> {
	debug(`Request execute npm-groovy-lint for ${textDocument.uri} with options ${JSON.stringify(opts)}`);
	const perfStart = performance.now();

	// Get settings and stop if action not enabled
	let settings = await docManager.getDocumentSettings(textDocument.uri);
	// Linter disabled
	if (settings.enable === false) {
		debug(`VsCodeGroovyLint is disabled: activate it in VsCode GroovyLint settings`);
		return Promise.resolve([]);
	}
	// Formatter disabled
	if (opts.format && settings.format.enable === false) {
		debug(`Formatter is disabled: activate it in VsCode settings`);
		return Promise.resolve([]);
	}
	// Fixer disabled
	if (opts.fix && settings.fix.enable === false) {
		debug(`Fixing is disabled: activate it in VsCode GroovyLint settings`);
		return Promise.resolve([]);
	}

	// In case lint was queues, get most recent version of textDocument
	textDocument = docManager.getUpToDateTextDocument(textDocument);
	let source: string = textDocument.getText();

	// Propose to replace tabs by spaces if there are, because CodeNarc hates tabs :/
	const fileNm = path.basename(textDocument.uri);
	source = await manageFixSourceBeforeCallingLinter(source, textDocument, docManager);

	// If user was prompted and did not respond, do not lint
	if (source === 'cancel') {
		debug(`User did not answer to the question: leave`);
		return Promise.resolve([]);
	}

	// Check if there is an existing NpmGroovyLint instance with same source (except if format, fix or force)
	let isSimpleLintIdenticalSource = false;
	const prevLinter = docManager.getDocLinter(textDocument.uri);
	if (prevLinter && prevLinter.options.source === source && ![opts.format, opts.fix, opts.force].includes(true)) {
		isSimpleLintIdenticalSource = true;
	}

	// Manage format & fix params
	let format = false;
	let verb = 'analyzing';
	// Add format param if necessary
	if (opts.format) {
		format = true;
		verb = 'formatting';
	}
	// Add fix param if necessary
	let fix = false;
	if (opts.fix) {
		fix = true;
		verb = 'auto-fixing';
	}

	// Remove already existing diagnostics except if format
	await docManager.resetDiagnostics(textDocument.uri, { verb: verb, deleteLinter: !isSimpleLintIdenticalSource });

	// Get a new task id
	const linterTaskId = docManager.getNewTaskId();

	// Notify client that lint is starting
	docManager.connection.sendNotification(StatusNotification.type, {
		id: linterTaskId,
		state: 'lint.start' + (fix ? '.fix' : format ? '.format' : ''),
		documents: [{ documentUri: textDocument.uri }],
		lastFileName: fileNm
	});

	// Build NmpGroovyLint config
	const npmGroovyLintConfig: any = {
		source: source,
		sourcefilepath: URI.parse(textDocument.uri).fsPath,
		parse: true, // Parse by default but not if format or fix mode
		nolintafter: true,
		loglevel: settings.basic.loglevel,
		returnrules: docManager.getRuleDescriptions().size > 0 ? false : true,
		output: 'none',
		verbose: settings.basic.verbose
	};

	const npmGroovyLintExecParam: any = {};

	// Request formatting
	if (format) {
		npmGroovyLintConfig.format = true;
		npmGroovyLintConfig.parse = false;
	} else if (fix) {
		// Request fixing
		npmGroovyLintConfig.fix = true;
		npmGroovyLintConfig.parse = false;
		// Request fixing only some rules
		if (opts.fixrules) {
			npmGroovyLintConfig.rulesets = opts.fixrules.join(',');
			npmGroovyLintConfig.fixrules = opts.fixrules.join(',');
		}
	}
	else {
		// Calculate requestKey (used to cancel current lint when a duplicate new one is incoming) only if not format or fix
		const requestKey = npmGroovyLintConfig.sourcefilepath + '-' + npmGroovyLintConfig.output;
		npmGroovyLintExecParam.requestKey = requestKey;
	}
	let linter;

	// If source has not changed, do not lint again
	if (isSimpleLintIdenticalSource === true) {
		debug(`Ignoring new analyze of ${textDocument.uri} as its content has not changed since previous lint`);
		linter = prevLinter;
	}
	else {
		// Run npm-groovy-lint linter/fixer
		docManager.deleteDocLinter(textDocument.uri);
		console.info(`Start ${verb} ${textDocument.uri}`);
		linter = new NpmGroovyLint(npmGroovyLintConfig, npmGroovyLintExecParam);
		try {
			await linter.run();
			if (!format) {
				docManager.setDocLinter(textDocument.uri, linter);
			}
			// Managed cancelled lint case
			if (linter.status === 9) {
				docManager.connection.sendNotification(StatusNotification.type, {
					id: linterTaskId,
					state: 'lint.cancel',
					documents: [{ documentUri: textDocument.uri }],
					lastFileName: fileNm
				});
				return Promise.resolve([]);
			}
		} catch (e) {
			// If error, send notification to client
			console.error('VsCode Groovy Lint error: ' + e.message + '\n' + e.stack);
			debug(`Error processing ${textDocument.uri}` + e.message + '\n' + e.stack);
			docManager.connection.sendNotification(StatusNotification.type, {
				id: linterTaskId,
				state: 'lint.error',
				documents: [{ documentUri: textDocument.uri }],
				lastFileName: fileNm
			});
			return Promise.resolve([]);
		}
		console.info(`Completed ${verb} ${textDocument.uri} in ${(performance.now() - perfStart).toFixed(0)} ms`);
	}

	// Parse results
	const lintResults = linter.lintResult || {};
	const { diagnostics, fixFailures } = parseLinterResults(lintResults, source, textDocument, docManager);

	// Store rules descriptions if returned
	if (lintResults.rules) {
		debug(`Store rule descriptions from NpmGroovyLint`);
		docManager.setRuleDescriptions(lintResults.rules);
	}

	textDocument = docManager.getUpToDateTextDocument(textDocument);
	const sourceAfterLintButBeforeApply: string = textDocument.getText();
	let textEdits: TextEdit[] = [];
	// Check if the document has been manually updated during the format or fix
	if ([format, fix].includes(true) && sourceAfterLintButBeforeApply !== source) {
		// Show message to user and propose to process again the format or fix action
		debug(`Source of ${textDocument.uri} has been updated: updates not applied`);
		const processAgainTitle = 'Process Again';
		const msg: ShowMessageRequestParams = {
			type: MessageType.Warning,
			message: `GroovyLint did not update the sources of ${path.parse(textDocument.uri).name} as it has been manually during the request`,
			actions: [
				{ title: processAgainTitle }
			]
		};
		docManager.connection.sendRequest('window/showMessageRequest', msg).then(async (rqstResp: any) => {
			// If user clicked Process Again, run again the related command
			if (rqstResp && rqstResp.title === processAgainTitle) {
				const commandAgain = (format) ? 'vscode.executeFormatDocumentProvider' : (fix) ? COMMAND_LINT_FIX.command : '';
				debug(`Process again command ${commandAgain} after user clicked on message`);
				await docManager.connection.client.executeCommand(commandAgain, [textDocument.uri], {});
			}
		});
	}
	// Send updated sources to client if format mode
	else if (format === true && linter.status === 0 && linter.lintResult.summary.totalFixedNumber > 0) {
		const updatedSource = getUpdatedSource(linter, source);
		if (opts.applyNow) {
			await applyTextDocumentEditOnWorkspace(docManager, textDocument, updatedSource);
		}
		else {
			const textEdit = createTextEdit(docManager, textDocument, updatedSource);
			textEdits.push(textEdit);
		}
		// Display fix failures if existing
		await notifyFixFailures(fixFailures, docManager);
	}
	// Send updated sources to client if fix mode
	else if (fix === true && linter.status === 0 && linter.lintResult.summary.totalFixedNumber > 0) {
		const updatedSource = getUpdatedSource(linter, source);
		await applyTextDocumentEditOnWorkspace(docManager, textDocument, updatedSource);
		// Display fix failures if existing
		await notifyFixFailures(fixFailures, docManager);
	}

	// Call if from lintFolder: open document and display diagnostics if 
	if (opts.showDocumentIfErrors == true && diagnostics.length > 0) {
		await docManager.connection.sendNotification(OpenNotification.type, { uri: textDocument.uri, preview: false });
		await docManager.updateDiagnostics(textDocument.uri, diagnostics);
	}
	// Remove diagnostics in case the file has been closed since the lint request
	else if (!docManager.isDocumentOpenInClient(textDocument.uri) && !(opts.displayErrorsEvenIfDocumentClosed === true)) {
		await docManager.updateDiagnostics(textDocument.uri, []);
	}
	// Update diagnostics if this is not a format or fix calls (for format & fix, a lint is called just after)
	else if (![format, fix].includes(true)) {
		await docManager.updateDiagnostics(textDocument.uri, diagnostics);
	}

	// Notify client of end of linting 
	docManager.connection.sendNotification(StatusNotification.type, {
		id: linterTaskId,
		state: 'lint.end' + (fix ? '.fix' : format ? '.format' : ''),
		documents: [{
			documentUri: textDocument.uri
		}],
		lastFileName: fileNm,
		lastLintTimeMs: performance.now() - perfStart
	});

	// Return textEdits only in case of formatting request
	return Promise.resolve(textEdits);
}

// If necessary, fix source before sending it to CodeNarc
async function manageFixSourceBeforeCallingLinter(source: string, textDocument: TextDocument, docManager: DocumentsManager): Promise<string> {
	if (source.includes("\t")) {
		let fixTabs = false;
		if (docManager.autoFixTabs === false) {
			const msg: ShowMessageRequestParams = {
				type: MessageType.Info,
				message: "CodeNarc linter doesn't like tabs, let's replace them by spaces ?",
				actions: [
					{ title: "Always (recommended)" },
					{ title: "Yes" },
					{ title: "No" },
					{ title: "Never" }]
			};
			let req: any;
			let msgResponseReceived = false;
			// When message box closes after no action, Promise is never fulfilled, so track that case to unlock linter queue
			setTimeout(async () => {
				if (msgResponseReceived === false) {
					await docManager.cancelDocumentValidation(textDocument.uri);
				}
			}, 10000);
			try {
				req = await docManager.connection.sendRequest('window/showMessageRequest', msg);
				msgResponseReceived = true;
			} catch (e) {
				debug('No response from showMessageRequest: ' + e.message);
				req = null;
			}
			if (req == null) {
				return 'cancel';
			} else if (req.title === "Always (recommended)") {
				docManager.autoFixTabs = true;
			} else if (req.title === "Yes") {
				fixTabs = true;
			}
		}
		if (docManager.autoFixTabs || fixTabs) {
			const replaceChars = " ".repeat(docManager.indentLength);
			source = source.replace(/\t/g, replaceChars);
			await applyTextDocumentEditOnWorkspace(docManager, textDocument, source);
			debug(`Replaces tabs by spaces in ${textDocument.uri}`);
		}
	}
	return source;
}
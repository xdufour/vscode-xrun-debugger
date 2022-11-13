/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * activateXrunDebug.ts containes the shared extension code that can be executed both in node.js and the browser.
 */

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { XrunDebugSession } from './xrunDebug';
import { FileAccessor } from './xrunRuntime';
import * as fs from 'fs';
import { parse } from 'yaml';

export function activateXrunDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {
	context.subscriptions.push(vscode.commands.registerCommand('extension.xrun-debug.SpecifyArgs', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter debug configuration command line options",
			value: ""
		});
	}));

	// register a configuration provider for 'xrun' debug type
	const provider = new XrunConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('xrun', provider));

	if (!factory) {
		factory = new InlineDebugAdapterFactory();
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('xrun', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	// override VS Code's default implementation of the debug hover
	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('systemverilog', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {

			const VARIABLE_REGEXP = /[a-z_\.][a-z0-9_]*/ig;
			const line = document.lineAt(position.line).text;

			let m: RegExpExecArray | null;
			while (m = VARIABLE_REGEXP.exec(line)) {
				let startIndex: number = 0;
				if(m[0].charAt(0) == '.'){
					let expressionIdx = line.search(/[a-z_][a-z0-9_\[\]]*\./);
					if(expressionIdx !== -1){
						startIndex = expressionIdx;
					}
				}
				else {
					startIndex = m.index;
				}
				const varRange = new vscode.Range(position.line, startIndex, position.line, m.index + m[0].length);

				let expression:string = line.substring(startIndex, m.index + m[0].length);
				if(expression.search(/\[.*\]/) !== -1){
					// FIXME: This eventually could query for the full array (will need to be done from within the DAP/runtime to provide array view)
					expression = expression.replace(/\[.*\]/, '[0]');
				}

				if (varRange.contains(position)) {
					return new vscode.EvaluatableExpression(varRange, expression);
				}
			}
			return undefined;
		}
	}));

	// override VS Code's default implementation of the "inline values" feature"
	context.subscriptions.push(vscode.languages.registerInlineValuesProvider('verilog', {
		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext) : vscode.ProviderResult<vscode.InlineValue[]> {
			const allValues: vscode.InlineValue[] = [];

			for (let l = viewport.start.line; l <= viewport.end.line; l++) {
				const line = document.lineAt(l);
				var regExp = /[a-z_][a-z0-9_]*/ig;
				do {
					var m = regExp.exec(line.text);
					if (m) {
						const varName = m[0];
						const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);
						// some literal text
						//allValues.push(new vscode.InlineValueText(varRange, `${varName}: ${viewport.start.line}`));

						// value found via variable lookup
						allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));

						// value determined via expression evaluation
						//allValues.push(new vscode.InlineValueEvaluatableExpression(varRange, varName));
					}
				} while (m);
			}

			return allValues;
		}
	}));
}

class XrunConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): Promise<vscode.DebugConfiguration | null | undefined> {

		// if launch.json is missing or empty
		if (config.args && config.args.search(/.*\.yml$/) !== -1) {
			let test = await vscode.window.showQuickPick(
				Object.keys(parse(fs.readFileSync(config.env + '/' + config.args, 'utf-8'))["tests"]),
				{
					canPickMany: false
				}
			).then((testName) => {
				return Promise.resolve(testName);
			});
			config.args = "-t " + test;
		}

		if (!config.program) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

export const workspaceFileAccessor: FileAccessor = {
	isWindows: false,
	async readFile(path: string): Promise<Uint8Array> {
		let uri: vscode.Uri;
		try {
			uri = pathToUri(path);
		} catch (e) {
			return new TextEncoder().encode(`cannot read '${path}'`);
		}

		return await vscode.workspace.fs.readFile(uri);
	},
	async writeFile(path: string, contents: Uint8Array) {
		await vscode.workspace.fs.writeFile(pathToUri(path), contents);
	}
};

function pathToUri(path: string) {
	try {
		return vscode.Uri.file(path);
	} catch (e) {
		return vscode.Uri.parse(path);
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new XrunDebugSession(workspaceFileAccessor));
	}
}

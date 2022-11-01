/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * activateMockDebug.ts containes the shared extension code that can be executed both in node.js and the browser.
 */

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { MockDebugSession } from './mockDebug';
import { FileAccessor } from './mockRuntime';
import * as fs from 'fs';
import { parse } from 'yaml';

export function activateMockDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {

	/* context.subscriptions.push(
		vscode.commands.registerCommand('extension.xrun-debug.runEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
					type: 'xrun',
					name: 'Run File',
					request: 'launch',
					program: targetResource.fsPath
				},
					{ noDebug: true }
				);
			}
		}),
		vscode.commands.registerCommand('extension.xrun-debug.debugEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
					type: 'xrun',
					name: 'Debug File',
					request: 'launch',
					program: targetResource.fsPath,
					stopOnEntry: true
				});
			}
		}),
		vscode.commands.registerCommand('extension.xrun-debug.toggleFormatting', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('toggleFormatting');
			}
		})
	); */

	context.subscriptions.push(vscode.commands.registerCommand('extension.xrun-debug.getRunSimArgs', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter all config options for run_sim.sh",
			value: "-t wfg1"
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.xrun-debug.getRunSimSelection', config => {
		return vscode.window.showQuickPick(
			// FIXME: Remove hardcoded path
			Object.keys(parse(fs.readFileSync("/home/cad/Design/Projects/bt005/bt005f/digital/Core_HDL_xdufour/ver" + "/config.yml", 'utf-8'))["tests"]),
			{
				canPickMany: false
			}
		).then((testName) => {
			return "-t " + testName;
		});
	}));

	// register a configuration provider for 'mock' debug type
	const provider = new MockConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('xrun', provider));

	// register a dynamic configuration provider for 'mock' debug type
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('xrun', {
		provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			return [
				{
					name: "Dynamic Launch",
					request: "launch",
					type: "xrun",
					program: "${file}"
				},
				{
					name: "Another Dynamic Launch",
					request: "launch",
					type: "xrun",
					program: "${file}"
				},
				{
					name: "Xrun Launch",
					request: "launch",
					type: "xrun",
					program: "${file}"
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

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
						const varName = m[1];
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

class MockConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.args) {
			return vscode.window.showInformationMessage("No arguments specified").then(_ => {
				return undefined;	// abort launch
			});
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
		return new vscode.DebugAdapterInlineImplementation(new MockDebugSession(workspaceFileAccessor));
	}
}

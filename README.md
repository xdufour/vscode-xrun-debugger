# Xrun Debugger

## Overview
A lightweight Verilog/SystemVerilog Debugger. It allows Cadence Xcelium Logic Simulator licensed users to interactively debug their designs & testbenches during simulation execution. Here's a list of features:

- Launch
- Breakpoints/Conditional Breakpoints
- Step In/Out/Over/Continue
- Variables
- Callstacks
- Debug console
- REPL Evaluation

## Requirements
- Xcelium 22.09-s001
- VS Code (version 1.66.0 or later)

## Install

Open VS Code and press `F1` or `Ctrl + Shift + P` to open command palette, select **Install Extension** and type `xrun-debug`.

Or launch VS Code Quick Open (`Ctrl + P`), paste the following command, and press enter.
```bash
ext install boreas-technologies.xrun-debug
```

## Use

- Launch VS Code
- Open a Verilog/SystemVerilog file to activate the extension
- Press `F5`

## Options

### Launch

- `program` - Absolute path to executable, or relative path if 'cwd' is specified. If the xrun tool has been exported to your user/global .bashrc, simply specify "xrun". If extensive configuration of the simulation or post-simulation handling of waveform databases is required, this can be a shell script calling xrun inlined, as long as it doesn't relinquish console output to another program (such as calling xrun with the -gui switch).
- `cwd` - The directory from which the executable program is called.
- `args` - The command line arguments passed to the xrun command.
  - `"${command:SpecifyArgs}"` - Prompt user for program arguments.
  - `file.yml` - Parse YAML configuration file under the "test" array and display a QuickPick to select an element as an argument.
  - A space-separated string or an array of string.
- `problemMatchers` - Lines that match against these keywords in the output console will be sent to stderr.
- `stopOnEntry` - Automatically stop after launch. Setting to false will cause simulator to run until the first user breakpoint.
- `noDebug` - Run simulation without debug.

## License
This extension is licensed under [MIT License](https://github.com/xdufour/vscode-xrun-debugger/blob/main/LICENSE).
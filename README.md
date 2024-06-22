# eBUS Notebook

A VS Code extension providing a notebook for eBUS activities using ebus-typespec and an optional ebusd connection, as well as some commands and code actions.

## Features

This extensions provides a VS Code notebook that eases the process of creating/manipulating eBUS message definitions in TypeSpec using the ebus-typespec library.

Such a notebook consists of several cells including typespec type cells that are used for defining the message(s).
Please refer to [`notebook.ebnb`](example/notebook.ebnb) for an example.

## Requirements

The best way to use this extension is by having an instance of ebusd running in the network that can be used to test and decode the message definition(s).

The ebusd instance needs to have the "--enabledefine" switch set in order to use it for that.

## Extension Settings

* `ebus-notebook.conversion.show`: Whether to show the conversion process terminal or use a task instead of a terminal.
* `ebus-notebook.conversion.cmd`: The command to use for converting TypeSpec to ebusd CSV, e.g. `tsp2ebusd -o ${outFile} ${inFile}`.
* `ebus-notebook.ebusd.host`: The host name or IP address of ebusd REPL to connect to, e.g. `localhost`.
* `ebus-notebook.ebusd.port`: The port number of ebusd REPL to connecto to, e.g. `8888` (default).

## Release Notes

Please refer to the CHANGELOG.md for release infos.

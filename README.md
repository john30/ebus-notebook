# ebus-notebook

A VS Code extension providing a notebook for eBUS activities using ebus-typespec and an optional ebusd connection.

## Features

This extensions provides a VS Code notebook that eases the process of creating/manipulating eBUS message definitions in TypeSpec using the ebus-typespec library.

Such a notebook consists of several cells including typespec type cells that are used for defining the message(s).
Please refer to [`notebook.ebnb`](example/notebook.ebnb) for an example.

## Requirements

The best way to use this extension is by having an instance of ebusd running in the network that can be used to test and decode the message definition(s).

The ebusd instance needs to have the "--enabledefine" switch set in order to use it for that.

## Release Notes

Please refer to the CHANGELOG.md for release infos.

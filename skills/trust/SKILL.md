---
name: trust
description: Manage trusted owner identities for channel security (add/remove/list)
user-invocable: true
context: inline
argument-hint: "add <channel> <userId> | remove <channel> <userId> | list"
---

Manage trusted owner identities. The user wants to:

$ARGUMENTS

Parse the arguments and call the trust() tool accordingly:

- `/trust add <channel> <userId>` → trust(action="add", channel="<channel>", userId="<userId>")
- `/trust remove <channel> <userId>` → trust(action="remove", channel="<channel>", userId="<userId>")
- `/trust list` → trust(action="list")

After executing, reply to the user with the result.

If the action is "add", also check if a channel Project needs to be created for this channel type
by calling create_project() with an appropriate configuration for handling non-owner messages.
The project name should be "channel:<channelType>" (e.g., "channel:telegram").
Only create the project if it doesn't already exist (check with list_projects() first).

If arguments are missing or unclear, ask the user what they want to do.

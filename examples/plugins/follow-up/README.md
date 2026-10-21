# Follow-up Prompts

An independently packaged API v2 extension using conversation context, text inference,
native settings, placeholders, commands, and contextual keybindings. It has no
special follow-up support in the FreeLM host and needs no account or general network
access. The authorized conversation text is sent to the selected model provider.

Package from the FreeLM checkout:

```sh
npm run plugin:pack -- examples/plugins/follow-up /tmp/follow-up.freelm-plugin
```

Install the package in Settings → Plugins, review its capabilities, and enable it.
Model defaults to Same as conversation; settings can select a configured model and
thinking effort, adjust recent exchanges, edit the prompt, and change the output budget.

Open a completed Chat or Code thread with an empty composer. A suggestion appears as
placeholder text. Click its acceptance control or press Tab while the composer is
focused to insert it as an undoable draft edit. Sending remains a separate user action.
Typing or attaching something dismisses it; erasing that input does not immediately
regenerate the suggestion. A completed answer, settings edit, or new activation can
trigger another suggestion. This plugin does not read temporary conversations.

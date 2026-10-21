# Notebook example

An independent FreeLM TypeScript plugin. Its runtime and UI are compiled during installation.

Package it from the FreeLM source checkout:

```sh
node scripts/package-plugin.mjs examples/plugins/notebook /tmp/notebook.freelm-plugin
```

In FreeLM, open Settings → Plugins → Install plugin, choose the package, review it, and install. Enable Notebook and add an account label such as Personal. Open its Notebook tab and save a note. Chat/Code/Bot tools stay unavailable until explicitly enabled in the plugin account's permissions.

There are no network permissions or OAuth credentials. Each account has its own note. Change this source, bump `version` in `manifest.json`, and import a new package to update the plugin without rebuilding FreeLM. Review tool grants again after updating. Plugin data is local to the host where it is installed.

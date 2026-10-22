---
"@palimvo/server": minor
"@palimvo/core": patch
"@palimvo/i18n": patch
---

Advanced MCP tools, reached through `list_tools`, `describe_tool` and `call_tool`: `create_folder`, `get_graph`, `create_checkpoint`, `restore_version` (one file), `create_base` and `list_file_types`. An OAuth connection can now be allowed to administer: the consent page offers "Also allow this app to administer the server" to people who may create vaults or publish plugins, and the grant then lists `create_vault` and `remove_vault` (the latter only moves a vault to the trash, after the vault id is repeated as `confirm`). API tokens never get these tools.

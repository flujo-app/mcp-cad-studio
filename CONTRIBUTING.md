# Contributing

Contributions are welcome. Please open an issue before a large architectural
change so the tool contract and model format can remain stable.

## Local setup

```bash
npm install
npm run check
```

Keep MCP data tools useful without the visual component. New UI actions should
call the same MCP tools exposed to models, and new mutations should return the
canonical studio snapshot when practical.

Please include tests for geometry behavior, schema changes, or transport changes.

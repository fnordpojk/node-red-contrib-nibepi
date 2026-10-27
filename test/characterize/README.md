# Characterization traces

These tests pin down what the nodes do today, so that a refactor can prove it changes
nothing. Each scenario in `scenarios.js` is a configuration, the plugin nodes a flow would
have, a simulated pump and simulated price and weather services. `harness.js` loads the
package's nodes with a fake Node-RED, a fake nibepi core, fake cron and HTTPS and a mocked
clock, runs the scenario minute by minute, and records every pump read and write, log
line, event between the nodes, dashboard message and HTTP request.

```sh
cd test/characterize && npm install      # once: suncalc
cd ../.. && npm test                     # compare against golden/
node test/characterize/run.js check price-tibber    # one scenario
```

A difference prints the first diverging events. When a change in behavior is intended,
re-record with `node test/characterize/run.js record` and review the change in the
recordings before committing them. `CHAR_PLAIN=1` also writes uncompressed copies next
to the `.gz` files, for reading.

The recordings describe the behavior as it is, including its faults. They are a safety
net for restructuring, not a statement of how NibePi should behave.

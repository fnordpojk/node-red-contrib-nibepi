# node-red-contrib-nibepi

Node-RED nodes for NibePi, an interface to Nibe F-series heat pumps.

This fork combines work from three repositories. None of the upstream authors
are involved in it, and none of them should be asked to support it.

- **[anerdins](https://github.com/anerdins/node-red-contrib-nibepi)** (Fredrik
  Anerdin) - original author of NibePi: the protocol layer, the nodes, the
  dashboard, the pump model database, and the electricity price, forecast
  control (prognosreglering) and SMHI weather features. Upstream development
  stopped after 1.2.1.
- **[ahsberg](https://github.com/ahsberg/node-red-contrib-nibepi)** (Martin
  Åhsberg) - kept those features working as their APIs changed, added
  elprisetjustnu.se alongside Tibber as a price source, and moved the price
  optimisation algorithm on-device after the cloud service that used to run it
  shut down. Hand-integrated rather than merged, so **none of it appears under
  his name in the git history**.
- **[pizzihelmet](https://github.com/pizzihelmet/node-red-contrib-nibepi)** -
  the VV-AI hot water learning system, pool support, and purchase price with
  VAT and markup shown in the price graph. Also hand-integrated, for the same
  reason.

The flows that go with these nodes are at
[fnordpojk/nibepi-flow](https://github.com/fnordpojk/nibepi-flow).

---

## What this is

Node-RED nodes for Nibe F-series heat pumps (and S-series over Modbus TCP),
built on the [nibepi-backend](https://github.com/fnordpojk/nibepi-backend) core.
They cover register read and write, hot water, ventilation, indoor climate,
weather compensation, electricity price control, and the VV-AI hot water
learning system.

One of four repositories:

| repo | what it is |
|---|---|
| [nibepi-backend](https://github.com/fnordpojk/nibepi-backend) | the core: transport, protocol, register database, MQTT |
| **node-red-contrib-nibepi** | this one: the Node-RED nodes |
| [nibepi-flow](https://github.com/fnordpojk/nibepi-flow) | the flows and dashboard that use them |
| [nibepi-docker](https://github.com/fnordpojk/nibepi-docker) | container packaging for all of it |

## Requirements

- Node.js 20 or newer
- Node-RED 3 or newer — developed against 5.0.9
- A way to reach the pump: an RS485 adapter, a NibeGW gateway over UDP, or
  Modbus TCP for S-series
- Modbus enabled on the pump itself — see
  [Enabling Modbus in the pump](https://github.com/fnordpojk/nibepi-backend#enabling-modbus-in-the-pump)

## Installing

```sh
cd ~/.node-red
npm install --save fnordpojk/node-red-contrib-nibepi#master
sudo systemctl restart nodered
```

The flows are a separate repository and have to match the nodes:
[fnordpojk/nibepi-flow](https://github.com/fnordpojk/nibepi-flow).

To run the whole stack in a container instead, see
[fnordpojk/nibepi-docker](https://github.com/fnordpojk/nibepi-docker).

## This is not an in-place upgrade from 1.2.1

Do not install this over a running anerdins 1.2.1 and keep the old flows. The
nodes and the flows changed together and only work as a pair: the flows here
drive nodes 1.2.1 does not have (`nibe-hotwater-ai`), and 1.2.1's flows drive
nodes that have since been rewritten. Replace both, or neither.

What does carry over: `config.json` is unchanged, and the VV-AI profile is
migrated from its old location automatically the first time the node loads.

**Home Assistant entity IDs change.** With MQTT discovery on, 2.0.0 publishes
the pump as one device, and each sensor now has a unique ID. 1.2.1's sensors had
none, so Home Assistant cannot carry them over: they are created anew, with IDs
taken from the device name, e.g. `sensor.nibe_bt1_outdoor_temperature` becomes
`sensor.nibe_f1245_bt1_outdoor_temperature` (your pump's model in place of
F1245). History recorded under the old IDs stays with the old IDs. After
upgrading, update dashboards, automations and template sensors that use them.
The old per-sensor discovery messages are removed from the broker
automatically.

The MQTT last will changed with it: NibePi now publishes `online`/`offline`,
retained, on `<topic prefix>status` (which the Home Assistant entities use for
availability), instead of `<client id> disconnected` on `nibe`.

Back up before you start:

```sh
cd ~/.node-red
cp -a node_modules/node-red-contrib-nibepi node-red-contrib-nibepi.bak
cp flows.json flows.json.bak
```

## Development

The files at the top level are the Node-RED nodes. `config_node.js` is the
configuration node: the connection to the pump, the schedules and the editor's
HTTP endpoints. The features live in `lib/`, one module each:

| module | |
|---|---|
| `shared.js` | pump reads with a short cache, the graph store, heat curve adjustments, errors to the dashboard |
| `plugins.js` | which registers each feature needs, and the regular run that reads them and runs the features |
| `price.js`, `price-trading.js` | price control, and the algorithm that turns prices into levels |
| `vvai.js` | VV-AI hot water learning and control |
| `weather.js`, `indoor.js`, `hotwater.js`, `fan.js`, `diagnostic.js`, `rmu.js` | the other features |

Each module is a function that takes a shared `ctx` object, picks what it needs
from it and returns what it offers; `config_node.js` creates them in dependency
order. State that is replaced while running, such as the register map `hP`, is
always read through `ctx`, never copied.

`npm test` runs the characterization traces in
[test/characterize](test/characterize/README.md): scenarios against a simulated
pump whose recorded behavior a change must reproduce.

## License

MIT, as upstream. See [LICENSE](LICENSE).

// ES-module entry for the shared match simulation (Cloudflare Worker, Node.js): same code as the browser's
// <script src="shared/sim.js">, which puts BVRSim on globalThis.
import './sim.js';
export default globalThis.BVRSim;

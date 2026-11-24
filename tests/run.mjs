// Mikron functional regression suite. Usage: node tests/run.mjs [name-filter]
import { runAll } from './lib/harness.mjs';
import './cases/arming.mjs';
import './cases/dragging.mjs';
import './cases/coexistence.mjs';
import './cases/pinned.mjs';
import './cases/blueprint.mjs';
import './cases/scanner.mjs';
import './cases/environments.mjs';
import './cases/settings.mjs';
import './cases/font.mjs';
import './cases/install.mjs';
import './cases/popup.mjs';
import './cases/rate.mjs';
import './cases/welcome.mjs';
import './cases/package.mjs';
import './cases/demo.mjs';
import './cases/site.mjs';
import './cases/hygiene.mjs'; // must stay last: its final case reloads the extension

const filter = process.argv[2] || process.env.MIKRON_FILTER || '';
const failed = await runAll({ filter });
process.exit(failed ? 1 : 0);

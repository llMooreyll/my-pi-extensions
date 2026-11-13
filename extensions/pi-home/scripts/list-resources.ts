// Dev tool: node scripts/list-resources.ts <cwd>
import { listContextFiles } from "../src/resources/context-files.ts";
import { listExtensions } from "../src/resources/extensions.ts";
import { listPackages } from "../src/resources/packages.ts";
import { listPrompts } from "../src/resources/prompts.ts";
import { listSkills } from "../src/resources/skills.ts";
import { isProjectTrusted } from "../src/resources/trust.ts";

const cwd = process.argv[2] ?? process.cwd();
const trusted = isProjectTrusted(cwd);
const { packages, missing, filtersIgnored } = listPackages(cwd, trusted);
console.log(
	JSON.stringify(
		{
			trusted,
			packages: packages.map((p) => ({
				source: p.source,
				scope: p.scope,
				dir: p.dir,
				extensions: p.extensions.length,
				skills: p.skills.length,
				prompts: p.prompts.length,
			})),
			missing,
			filtersIgnored,
			extensions: listExtensions(cwd, trusted),
			skills: listSkills(cwd, trusted),
			prompts: listPrompts(cwd, trusted),
			contextFiles: listContextFiles(cwd),
		},
		null,
		2,
	),
);

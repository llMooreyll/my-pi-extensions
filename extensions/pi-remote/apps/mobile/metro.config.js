const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const protocolRoot = path.resolve(projectRoot, "../../packages/protocol");
const config = getDefaultConfig(projectRoot);
// The shared protocol package lives outside the app (linked via file:).
config.watchFolders = [protocolRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.unstable_enablePackageExports = true;
module.exports = config;

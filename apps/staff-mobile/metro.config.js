// Metro for the staff app. The app sits outside the pnpm workspace (own lockfile) but reads the shared
// response verifiers from packages/contracts source, so Metro must watch that folder and map the contracts'
// ESM-style "./x.js" specifiers to their ".ts" sources.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const contracts = path.resolve(__dirname, '../../packages/contracts/src');
config.watchFolders = [...(config.watchFolders ?? []), contracts];
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('@hon/contracts/')) {
    return context.resolveRequest(context, path.join(contracts, moduleName.slice('@hon/contracts/'.length)), platform);
  }
  if (context.originModulePath.startsWith(contracts) && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;

import { logger } from '../../logger';
import { PackageDependency, PackageFile } from '../common';
import * as datasourceDocker from '../../datasource/docker';
import { SkipReason } from '../../types';

export function splitImageParts(currentFrom: string): PackageDependency {
  if (currentFrom.includes('$')) {
    return {
      skipReason: SkipReason.ContainsVariable,
    };
  }
  const [currentDepTag, currentDigest] = currentFrom.split('@');
  const depTagSplit = currentDepTag.split(':');
  let depName: string;
  let currentValue: string;
  if (
    depTagSplit.length === 1 ||
    depTagSplit[depTagSplit.length - 1].includes('/')
  ) {
    depName = currentDepTag;
  } else {
    currentValue = depTagSplit.pop();
    depName = depTagSplit.join(':');
  }
  const dep: PackageDependency = {
    depName,
    currentValue,
    currentDigest,
  };
  return dep;
}

export function getDep(currentFrom: string): PackageDependency {
  const dep = splitImageParts(currentFrom);
  dep.autoReplaceData = {
    replaceString: currentFrom,
  };
  dep.datasource = datasourceDocker.id;
  if (
    dep.depName &&
    (dep.depName === 'node' || dep.depName.endsWith('/node')) &&
    dep.depName !== 'calico/node'
  ) {
    dep.commitMessageTopic = 'Node.js';
  }
  return dep;
}

export function extractPackageFile(content: string): PackageFile | null {
  const deps: PackageDependency[] = [];
  const stageNames: string[] = [];
  let lineNumber = 0;
  for (const fromLine of content.split('\n')) {
    const fromMatch = /^FROM /i.test(fromLine);
    if (fromMatch) {
      logger.trace({ lineNumber, fromLine }, 'FROM line');
      const [fromPrefix, currentFrom, ...fromRest] = fromLine.match(/\S+/g);
      if (fromRest.length === 2 && fromRest[0].toLowerCase() === 'as') {
        logger.debug('Found a multistage build stage name');
        stageNames.push(fromRest[1]);
      }
      const fromSuffix = fromRest.join(' ');
      if (currentFrom === 'scratch') {
        logger.debug('Skipping scratch');
      } else if (stageNames.includes(currentFrom)) {
        logger.debug({ currentFrom }, 'Skipping alias FROM');
      } else {
        const dep = getDep(currentFrom);
        logger.trace(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile FROM'
        );
        dep.managerData = {
          lineNumber,
          fromPrefix,
          fromSuffix,
        };
        deps.push(dep);
      }
    }

    const copyFromMatch = /^(COPY --from=)([^\s]+)\s+(.*)$/i.exec(fromLine);
    if (copyFromMatch) {
      const [, fromPrefix, currentFrom, fromSuffix] = copyFromMatch;
      logger.trace({ lineNumber, fromLine }, 'COPY --from line');
      if (stageNames.includes(currentFrom)) {
        logger.debug({ currentFrom }, 'Skipping alias COPY --from');
      } else if (!Number.isNaN(Number(currentFrom))) {
        logger.debug({ currentFrom }, 'Skipping index reference COPY --from');
      } else {
        const dep = getDep(currentFrom);
        logger.debug(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
          },
          'Dockerfile COPY --from'
        );
        dep.managerData = {
          lineNumber,
          fromPrefix,
          fromSuffix,
        };
        deps.push(dep);
      }
    }
    lineNumber += 1;
  }
  if (!deps.length) {
    return null;
  }
  for (const d of deps) {
    d.depType = 'stage';
  }
  deps[deps.length - 1].depType = 'final';
  return { deps };
}

import iconMap from './icon-map.json';
import type { FileExtensionsKey, FileNamesKey, FolderNamesKey } from './type';

function getFileExtension(fileName: string): string {
  return fileName.slice(Math.max(0, fileName.lastIndexOf('.') + 1));
}

function getFileSuffix(fileName: string): FileExtensionsKey {
  return fileName.slice(fileName.indexOf('.') + 1) as FileExtensionsKey;
}

export function filenameFromPath(path: string): string {
  const segments = path.split('/');
  return segments.at(-1) ?? path;
}

export function getIconNameForFileName(fileName: string) {
  return (
    iconMap.fileNames[fileName as FileNamesKey] ??
    iconMap.fileNames[fileName.toLowerCase() as FileNamesKey] ??
    iconMap.fileExtensions[getFileSuffix(fileName)] ??
    iconMap.fileExtensions[getFileExtension(fileName) as FileExtensionsKey] ??
    (fileName.endsWith('.html') ? 'html' : null) ??
    (fileName.endsWith('.ts') ? 'typescript' : null) ??
    (fileName.endsWith('.js') ? 'javascript' : null) ??
    'file'
  );
}

export function getIconNameForDirectoryName(dirName: string) {
  return (
    iconMap.folderNames[dirName as FolderNamesKey] ??
    iconMap.folderNames[dirName.toLowerCase() as FolderNamesKey] ??
    'folder'
  );
}

export function getIconForFilePath(path: string) {
  const fileName = filenameFromPath(path);
  return getIconNameForFileName(fileName);
}

export function getIconForDirectoryPath(path: string) {
  const dirName = filenameFromPath(path);
  return getIconNameForDirectoryName(dirName);
}



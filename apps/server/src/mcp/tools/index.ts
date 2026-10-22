import type { AnyTool } from "../registry.ts";
import { entryTools } from "../entry.ts";
import { createVault, removeVault } from "./admin.ts";
import {
  createBase,
  createCheckpoint,
  createFolder,
  getGraph,
  listFileTypes,
  restoreVersion,
} from "./advanced.ts";
import { queryBaseTool } from "./bases.ts";
import { editCanvas, readCanvas } from "./canvas.ts";
import { downloadFile, uploadFile } from "./files.ts";
import { getDiff, getHistory } from "./history.ts";
import {
  createNote,
  deleteNote,
  getBacklinks,
  listFiles,
  moveNote,
  readNote,
  search,
  setNotePropertyTool,
  updateNote,
} from "./notes.ts";
import { createEditProposal, getEditProposal, listEditProposals } from "./proposals.ts";
import {
  beginUpload,
  cancelUpload,
  createUploadLink,
  finishUpload,
  uploadPart,
} from "./uploads.ts";
import { listVaults } from "./vaults.ts";

/**
 * Every tool the server ships: the ones in `tools/list` (about 20 with the entry tools) and the
 * advanced ones reached through `call_tool`. Advanced tools that need services which do not exist
 * yet (plugins, components, vault settings) are added with those services.
 */
export function coreTools(): AnyTool[] {
  return [
    listVaults,
    listFiles,
    readNote,
    search,
    getBacklinks,
    createNote,
    updateNote,
    moveNote,
    deleteNote,
    setNotePropertyTool,
    readCanvas,
    editCanvas,
    getHistory,
    getDiff,
    uploadFile,
    downloadFile,
    queryBaseTool,
    createEditProposal,
    listEditProposals,
    getEditProposal,
    ...entryTools(),
    createFolder,
    getGraph,
    createCheckpoint,
    restoreVersion,
    createBase,
    listFileTypes,
    beginUpload,
    uploadPart,
    finishUpload,
    cancelUpload,
    createUploadLink,
    createVault,
    removeVault,
  ];
}

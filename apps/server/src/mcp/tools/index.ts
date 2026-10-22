import type { AnyTool } from "../registry.ts";
import { entryTools } from "../entry.ts";
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
import { listVaults } from "./vaults.ts";

/**
 * Every tool the server ships that appears in `tools/list` (about 20 with the entry tools).
 * The other advanced tools (T29) are added later.
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
  ];
}

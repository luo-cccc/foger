import type { CreateState } from "../../types";

export const initialCreateState: CreateState = {
  bookDataVersion: 0,
  sidebarView: "panel",
  artifactFile: null,
  artifactEpisode: null,
  bookSummary: null,
  resolvedProposals: {},
};

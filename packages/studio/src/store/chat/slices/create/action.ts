import type { StateCreator } from "zustand";
import type { ChatStore, CreateActions } from "../../types";

export const createCreateSlice: StateCreator<ChatStore, [], [], CreateActions> = (set) => ({
  bumpBookDataVersion: () => set((s) => ({ bookDataVersion: s.bookDataVersion + 1 })),
  openArtifact: (file) => set({ sidebarView: "artifact", artifactFile: file, artifactEpisode: null }),
  openEpisodeArtifact: (episodeNum) => set({ sidebarView: "artifact", artifactFile: null, artifactEpisode: episodeNum }),
  closeArtifact: () => set({ sidebarView: "panel", artifactFile: null, artifactEpisode: null }),
  setBookSummary: (summary) => set({ bookSummary: summary }),
  markProposalResolved: (execId, resolution) =>
    set((s) => ({ resolvedProposals: { ...s.resolvedProposals, [execId]: resolution } })),
});

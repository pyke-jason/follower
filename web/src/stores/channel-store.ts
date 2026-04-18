import { create } from 'zustand';
import type { StatusResponse, ChannelBrief } from '@/lib/api-types';

interface ChannelState {
  channelId: string | null;
  defaultChannelId: string | null;
  status: StatusResponse | null;
  statusError: string | null;
  channelBrief: ChannelBrief | undefined;

  setChannelId: (id: string) => void;
  setDefaultChannelId: (id: string) => void;
  setStatus: (status: StatusResponse | null, error: string | null) => void;
  selectChannel: (id: string) => void;
}

export const useChannelStore = create<ChannelState>((set) => ({
  channelId: null,
  defaultChannelId: null,
  status: null,
  statusError: null,
  channelBrief: undefined,

  setChannelId: (id) => set({ channelId: id }),
  setDefaultChannelId: (id) => set({ defaultChannelId: id }),
  setStatus: (status, error) =>
    set({ status, statusError: error, channelBrief: status?.channelBrief }),

  selectChannel: () => {},
}));

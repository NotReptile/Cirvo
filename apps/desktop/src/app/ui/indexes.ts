import { uiContext } from "../state";
import type { Channel, DMItem, FriendItem, Member } from "../types";

function memoIndex<T, K>(
  items: () => readonly T[],
  key: (value: T) => K,
): () => ReadonlyMap<K, T> {
  let source: readonly T[] | undefined, index: Map<K, T>;
  return () => {
    const next = items();
    if (source !== next) {
      source = next;
      index = new Map(next.map((value) => [key(value), value]));
    }
    return index;
  };
}
export const membersById = memoIndex<Member, string>(
  () => uiContext.state.members,
  (member) => member.userId,
);
export const membersByUsername = memoIndex<Member, string>(
  () => uiContext.state.members,
  (member) => member.username,
);
export const channelsByName = memoIndex<Channel, string>(
  () => uiContext.state.channels,
  (channel) => channel.name.toLowerCase(),
);
export const dmsByPeer = memoIndex<DMItem, string>(
  () => uiContext.state.dms,
  (dm) => dm.peer.userId,
);
export const friendsById = memoIndex<FriendItem, string>(
  () => uiContext.state.friends,
  (friend) => friend.userId,
);

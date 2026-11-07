import * as Network from "expo-network";
import { useEffect, useState } from "react";

/**
 * Does the phone believe it has a network connection? "Believes" is the key word: Wi-Fi without internet still counts as online,
 * which is why a request that gets no answer is queued even when this says true. Unknown is treated as online.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let live = true;
    void Network.getNetworkStateAsync().then((s) => { if (live) setOnline(s.isConnected !== false); }).catch(() => undefined);
    const sub = Network.addNetworkStateListener((s) => setOnline(s.isConnected !== false));
    return () => { live = false; sub.remove(); };
  }, []);
  return online;
}

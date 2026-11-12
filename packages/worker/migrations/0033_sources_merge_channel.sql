-- Optional per-source channel folding: when merge_channel_name is set, every
-- line from the source is attached to one channel (e.g. 虎牙直播) instead of
-- one channel per stream room. merge_channel_group becomes that channel's group.
ALTER TABLE sources ADD COLUMN merge_channel_name TEXT;
ALTER TABLE sources ADD COLUMN merge_channel_group TEXT;

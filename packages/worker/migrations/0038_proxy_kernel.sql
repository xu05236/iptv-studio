-- Kernel-only protocols (vmess/vless/trojan/shadowsocks/...) cannot be reached
-- over a plain HTTP/SOCKS proxy; the runner needs a local kernel. Store the
-- original node config encrypted next to the row, and which engine reads it.
ALTER TABLE proxy_nodes ADD COLUMN config_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE proxy_nodes ADD COLUMN engine TEXT NOT NULL DEFAULT '';

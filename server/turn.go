package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strconv"
	"time"
)

// Long enough for a 20 GiB file at the relay's per-session speed limit (about 2 h).
const turnTTL = 3 * time.Hour

type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// turnServers returns short-lived relay credentials in coturn's use-auth-secret form.
func turnServers(secret, host string, now time.Time) []ICEServer {
	if secret == "" || host == "" {
		return nil // relay not configured: browsers use direct and STUN paths only
	}
	username := strconv.FormatInt(now.Add(turnTTL).Unix(), 10) + ":streamdrop"
	mac := hmac.New(sha1.New, []byte(secret)) // SHA-1 is what coturn's auth-secret mode requires
	mac.Write([]byte(username))
	return []ICEServer{{
		URLs: []string{
			"turn:" + host + ":3478?transport=udp",
			"turn:" + host + ":3478?transport=tcp",
		},
		Username:   username,
		Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
	}}
}

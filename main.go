package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	relay      = "__teamsVimiumRelay"
	download   = "__teamsmonkeyDownloadScriptBinding"
	fetchBind  = "__teamsmonkeyFetchBinding"
	removeBind = "__teamsmonkeyRemoveScriptBinding"
	dirsBind   = "__teamsmonkeyScriptDirectoriesBinding"
	cdpPort    = "9223"
)

type Script struct {
	Name, Version, Path, Source, Hash, RunAt string
	Toggleable                               bool
	Includes, Excludes                       []*regexp.Regexp
}
type Meta struct{ m map[string][]string }
type Target struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
	WS    string `json:"webSocketDebuggerUrl"`
	Type  string `json:"type"`
}
type Conn struct {
	ws            *websocket.Conn
	mu            sync.Mutex
	next          int
	pending       map[int]chan result
	registrations []string
	revision      int
	hint          string
}
type result struct {
	v   map[string]interface{}
	err error
}
type Loader struct {
	port, scriptsDir, bundled, target, host string
	poll                                    time.Duration
	config                                  string
	dirs                                    []string
	scripts                                 []Script
	rev                                     int
	signature                               string
	conns                                   map[string]*Conn
	token                                   string
}

func optionDefaults() *Loader {
	home, _ := os.UserHomeDir()
	cfg := os.Getenv("XDG_CONFIG_HOME")
	if cfg == "" {
		cfg = filepath.Join(home, ".config")
	}
	sd := filepath.Join(cfg, "teamsmonkey", "scripts")
	if runtime.GOOS == "windows" {
		sd = filepath.Join(os.Getenv("APPDATA"), "teamsmonkey", "scripts")
	}
	l := &Loader{port: "9222", scriptsDir: sd, bundled: "bundled-userscripts", target: "teams.", poll: time.Second, config: filepath.Join(cfg, "teamsmonkey", "script-directories.json"), conns: map[string]*Conn{}}
	return l
}
func main() {
	l := optionDefaults()
	flag.StringVar(&l.port, "port", l.port, "")
	flag.StringVar(&l.scriptsDir, "scripts", os.Getenv("TEAMSMONKEY_SCRIPT_PATH"), "")
	flag.StringVar(&l.target, "target", l.target, "")
	flag.StringVar(&l.host, "host", "", "")
	var ms int
	flag.IntVar(&ms, "poll-ms", 1000, "")
	installService := flag.Bool("service-install", false, "install the Teamsmonkey service")
	uninstallService := flag.Bool("service-uninstall", false, "remove the Teamsmonkey service")
	flag.Parse()
	if *installService || *uninstallService {
		if e := manageService(*installService); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		return
	}
	if l.scriptsDir == "" {
		l.scriptsDir = optionDefaults().scriptsDir
	}
	l.poll = time.Duration(ms) * time.Millisecond
	exe, _ := os.Executable()
	l.bundled = filepath.Join(filepath.Dir(exe), "bundled-userscripts")
	if _, e := os.Stat(l.bundled); e != nil {
		l.bundled = "bundled-userscripts"
	}
	l.token = token()
	l.readDirs()
	os.MkdirAll(l.scriptsDir, 0755)
	l.load()
	fmt.Printf("Watching %s; bundled scripts from %s; looking for Teams CDP targets on localhost:%s\n", l.scriptsDir, l.bundled, l.port)
	for {
		if e := l.reconcile(); e != nil {
			fmt.Fprintln(os.Stderr, "Waiting for Teams CDP endpoint:", e)
		}
		time.Sleep(l.poll)
	}
}
func token() string {
	if v := os.Getenv("TEAMSMONKEY_GITHUB_TOKEN"); v != "" {
		return v
	}
	paths := []string{os.Getenv("TEAMSMONKEY_GH_PATH"), "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"}
	for _, p := range paths {
		if p == "" {
			continue
		}
		b, e := exec.Command(p, "auth", "token").Output()
		if e == nil && strings.TrimSpace(string(b)) != "" {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}
func (l *Loader) readDirs() {
	b, e := os.ReadFile(l.config)
	if e == nil {
		json.Unmarshal(b, &l.dirs)
	}
	for i := range l.dirs {
		l.dirs[i], _ = filepath.Abs(l.dirs[i])
	}
}
func (l *Loader) saveDirs() {
	os.MkdirAll(filepath.Dir(l.config), 0755)
	b, _ := json.MarshalIndent(l.dirs, "", "  ")
	os.WriteFile(l.config, append(b, '\n'), 0644)
}
func meta(src string) Meta {
	m := Meta{map[string][]string{}}
	r := regexp.MustCompile(`(?m)^\s*//\s*@([^\s]+)\s+(.+?)\s*$`)
	block := regexp.MustCompile(`(?s)//\s*==UserScript==(.+?)//\s*==/UserScript==`).FindStringSubmatch(src)
	if len(block) > 1 {
		for _, x := range r.FindAllStringSubmatch(block[1], -1) {
			m.m[x[1]] = append(m.m[x[1]], strings.TrimSpace(x[2]))
		}
	}
	return m
}
func wild(s string) *regexp.Regexp {
	q := regexp.QuoteMeta(s)
	q = strings.ReplaceAll(q, "\\*", ".*")
	r, _ := regexp.Compile("^" + q + "$")
	return r
}
func (l *Loader) load() {
	dirs := append([]string{l.bundled, l.scriptsDir}, l.dirs...)
	seen := map[string]string{}
	for _, d := range dirs {
		es, _ := os.ReadDir(d)
		for _, e := range es {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".user.js") {
				if _, ok := seen[e.Name()]; !ok {
					seen[e.Name()] = filepath.Join(d, e.Name())
				}
			}
		}
	}
	names := make([]string, 0, len(seen))
	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)
	out := []Script{}
	for _, n := range names {
		p := seen[n]
		b, e := os.ReadFile(p)
		if e != nil {
			continue
		}
		s := string(b)
		m := meta(s)
		inc := append(append([]string{}, m.m["match"]...), m.m["include"]...)
		exc := append(append([]string{}, m.m["exclude-match"]...), m.m["exclude"]...)
		if len(inc) == 0 {
			inc = []string{"https://teams.*/*"}
		}
		x := Script{Name: first(m.m["name"], n), Version: first(m.m["version"], "0.0.0"), Path: p, Source: s, RunAt: first(m.m["run-at"], "document-idle"), Toggleable: first(m.m["toggleable"], "true") != "false"}
		h := sha256.Sum256(b)
		x.Hash = hex.EncodeToString(h[:])[:12]
		for _, v := range inc {
			x.Includes = append(x.Includes, wild(v))
		}
		for _, v := range exc {
			x.Excludes = append(x.Excludes, wild(v))
		}
		out = append(out, x)
	}
	var signature strings.Builder
	for _, s := range out {
		fmt.Fprintf(&signature, "%s\x00%s\x00%s\x00%s\x00%t\x00", s.Name, s.Version, s.Path, s.Hash, s.Toggleable)
		for _, r := range s.Includes {
			signature.WriteString(r.String())
			signature.WriteByte(0)
		}
		for _, r := range s.Excludes {
			signature.WriteString(r.String())
			signature.WriteByte(0)
		}
	}
	if signature.String() == l.signature {
		return
	}
	l.signature = signature.String()
	l.scripts = out
	l.rev++
	fmt.Printf("Loaded %d userscript(s)\n", len(out))
}
func first(a []string, d string) string {
	if len(a) > 0 {
		return a[0]
	}
	return d
}
func applies(s Script, u string) bool {
	ok := false
	for _, r := range s.Includes {
		if r.MatchString(u) {
			ok = true
		}
	}
	for _, r := range s.Excludes {
		if r.MatchString(u) {
			return false
		}
	}
	return ok
}
func jsq(v interface{}) string { b, _ := json.Marshal(v); return string(b) }
func (l *Loader) bridge() string {
	return fmt.Sprintf(`(() => { const make=(key,binding)=>{const p=globalThis[key]??=new Map();let n=0;globalThis[key.replace('Pending','Result')]=(id,r)=>{const x=p.get(id);if(!x)return;p.delete(id);r.ok?x[0](r):x[1](new Error(r.error))};return q=>new Promise((a,b)=>{let id=String(++n);p.set(id,[a,b]);globalThis[binding](JSON.stringify({requestId:id,...q}))})};globalThis.__teamsmonkeyDownloadScript=make('__teamsmonkeyDownloadScriptPending','%s');globalThis.__teamsmonkeyFetch=make('__teamsmonkeyFetchPending','%s');globalThis.__teamsmonkeyRemoveScript=make('__teamsmonkeyRemoveScriptPending','%s');globalThis.__teamsmonkeyScriptDirectories=make('__teamsmonkeyScriptDirectoriesPending','%s');})()`, download, fetchBind, removeBind, dirsBind)
}
func (l *Loader) manifest() string {
	a := []map[string]interface{}{}
	for _, s := range l.scripts {
		m := map[string]interface{}{"name": s.Name, "toggleable": s.Toggleable, "version": s.Version, "filename": filepath.Base(s.Path), "removable": filepath.Dir(s.Path) == l.scriptsDir, "includes": regexSources(s.Includes), "excludes": regexSources(s.Excludes)}
		for _, d := range l.dirs {
			if filepath.Dir(s.Path) == d {
				m["sourcePath"] = s.Path
			}
		}
		a = append(a, m)
	}
	return `globalThis.__teamsUserscriptManifest=` + jsq(a) + `.filter(e=>e.includes.some(v=>new RegExp(v).test(location.href))&&!e.excludes.some(v=>new RegExp(v).test(location.href))).map(({name,version,toggleable,filename,sourcePath,removable})=>({name,version,toggleable,filename,sourcePath,removable}))`
}
func regexSources(a []*regexp.Regexp) []string {
	o := []string{}
	for _, r := range a {
		o = append(o, r.String()[1:len(r.String())-1])
	}
	return o
}
func (l *Loader) wrapped(s Script, disabled []string) string {
	inc, exc := regexSources(s.Includes), regexSources(s.Excludes)
	key := s.Name + ":" + s.Hash
	ex := fmt.Sprintf(`()=>{const r=globalThis.__teamsUserscriptLoader??=new Set();if(r.has(%s))return;r.add(%s);try{%s}catch(error){console.error(%s,error)}}`, jsq(key), jsq(key), s.Source, jsq("[userscript] "+s.Name))
	var schedule string
	switch s.RunAt {
	case "document-start":
		schedule = "(" + ex + ")()"
	case "document-end":
		schedule = "document.readyState==='loading'?document.addEventListener('DOMContentLoaded'," + ex + ",{once:true}):(" + ex + ")()"
	default:
		schedule = "document.readyState==='complete'?setTimeout(" + ex + ",0):addEventListener('load',()=>setTimeout(" + ex + ",0),{once:true})"
	}
	return fmt.Sprintf(`(()=>{const u=location.href,i=%s.map(v=>new RegExp(v)),e=%s.map(v=>new RegExp(v));if(!i.some(p=>p.test(u))||e.some(p=>p.test(u)))return;const d=%s;if(%t&&d.includes(%s)){(globalThis.__teamsUserscriptLoader??=new Set()).add(%s);return};%s})();//# sourceURL=teams-userscript://%s.user.js`, jsq(inc), jsq(exc), jsq(disabled), s.Toggleable, jsq(s.Name), jsq(key), schedule, url.QueryEscape(s.Name))
}
func (l *Loader) request(c *Conn, method string, params map[string]interface{}) (map[string]interface{}, error) {
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan result, 1)
	c.pending[id] = ch
	e := c.ws.WriteJSON(map[string]interface{}{"id": id, "method": method, "params": params})
	c.mu.Unlock()
	if e != nil {
		return nil, e
	}
	select {
	case x := <-ch:
		return x.v, x.err
	case <-time.After(10 * time.Second):
		return nil, fmt.Errorf("%s timed out", method)
	}
}
func connect(l *Loader, wsurl string) (*Conn, error) {
	u := websocket.DefaultDialer
	s, _, e := u.Dial(wsurl, nil)
	if e != nil {
		return nil, e
	}
	c := &Conn{ws: s, pending: map[int]chan result{}}
	go func() {
		for {
			var m map[string]interface{}
			if e := s.ReadJSON(&m); e != nil {
				fmt.Fprintf(os.Stderr, "CDP connection closed: %v\n", e)
				return
			}
			if method, ok := m["method"].(string); ok && method == "Runtime.bindingCalled" {
				if p, ok := m["params"].(map[string]interface{}); ok {
					l.binding(c, fmt.Sprint(p["name"]), fmt.Sprint(p["payload"]))
				}
				continue
			}
			if id, ok := m["id"].(float64); ok {
				c.mu.Lock()
				ch := c.pending[int(id)]
				delete(c.pending, int(id))
				c.mu.Unlock()
				if ch != nil {
					if er, ok := m["error"].(map[string]interface{}); ok {
						ch <- result{err: errors.New(fmt.Sprint(er["message"]))}
					} else {
						v, _ := m["result"].(map[string]interface{})
						ch <- result{v: v}
					}
				}
			}
		}
	}()
	return c, nil
}
func (l *Loader) install(c *Conn, t Target, disabled []string) error {
	for _, id := range c.registrations {
		if _, e := l.request(c, "Page.removeScriptToEvaluateOnNewDocument", map[string]interface{}{"identifier": id}); e != nil {
			return fmt.Errorf("remove previous script: %w", e)
		}
	}
	c.registrations = nil
	for _, b := range []string{relay, download, fetchBind, removeBind, dirsBind} {
		if _, e := l.request(c, "Runtime.addBinding", map[string]interface{}{"name": b}); e != nil {
			return fmt.Errorf("add binding %q: %w", b, e)
		}
	}
	if _, e := l.request(c, "Runtime.enable", nil); e != nil {
		return fmt.Errorf("enable runtime: %w", e)
	}
	if _, e := l.request(c, "Page.enable", nil); e != nil {
		return fmt.Errorf("enable page: %w", e)
	}
	for _, src := range []string{`globalThis.__teamsVimiumHintContext={}`, l.manifest(), l.bridge()} {
		if _, e := l.request(c, "Runtime.evaluate", map[string]interface{}{"expression": src}); e != nil {
			return fmt.Errorf("evaluate bootstrap: %w", e)
		}
	}
	for _, s := range l.scripts {
		x := l.wrapped(s, disabled)
		r, e := l.request(c, "Page.addScriptToEvaluateOnNewDocument", map[string]interface{}{"source": x})
		if e != nil {
			return e
		}
		if z, ok := r["identifier"].(string); ok {
			c.registrations = append(c.registrations, z)
		}
		if applies(s, t.URL) {
			if _, e := l.request(c, "Runtime.evaluate", map[string]interface{}{"expression": x, "awaitPromise": true}); e != nil {
				return fmt.Errorf("evaluate %q: %w", s.Name, e)
			}
		}
	}
	c.revision = l.rev
	return nil
}
func (l *Loader) reply(c *Conn, fn string, id interface{}, v interface{}, ok bool) {
	r := map[string]interface{}{"ok": ok}
	if ok {
		if m, yes := v.(map[string]interface{}); yes {
			for k, x := range m {
				r[k] = x
			}
		}
	} else {
		r["error"] = fmt.Sprint(v)
	}
	l.request(c, "Runtime.evaluate", map[string]interface{}{"expression": fmt.Sprintf("globalThis.%s(%s,%s)", fn, jsq(id), jsq(r))})
}
func (l *Loader) binding(c *Conn, name, payload string) {
	var q map[string]interface{}
	if json.Unmarshal([]byte(payload), &q) != nil {
		return
	}
	id := q["requestId"]
	switch name {
	case relay:
		for _, peer := range l.conns {
			if peer != c {
				l.request(peer, "Runtime.evaluate", map[string]interface{}{"expression": "globalThis.__teamsVimium?.receiveRelayedKey(" + jsq(payload) + ")"})
			}
		}
	case fetchBind:
		u, _ := url.Parse(fmt.Sprint(q["url"]))
		if u.Scheme != "https" {
			l.reply(c, "__teamsmonkeyFetchResult", id, "Only HTTPS URLs can be fetched", false)
			return
		}
		req, _ := http.NewRequest("GET", u.String(), nil)
		if l.token != "" && u.Hostname() == "raw.githubusercontent.com" {
			req.Header.Set("Authorization", "Bearer "+l.token)
		}
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			l.reply(c, "__teamsmonkeyFetchResult", id, e, false)
			return
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		l.reply(c, "__teamsmonkeyFetchResult", id, map[string]interface{}{"status": res.StatusCode, "ok": res.StatusCode >= 200 && res.StatusCode < 300, "text": string(b)}, true)
	case download, removeBind:
		fn := fmt.Sprint(q["filename"])
		if name == download {
			src := fmt.Sprint(q["source"])
			if filepath.Base(fn) != fn || !strings.HasSuffix(fn, ".user.js") || !regexp.MustCompile(`(?m)^\s*//\s*==UserScript==`).MatchString(src) {
				l.reply(c, "__teamsmonkeyDownloadScriptResult", id, "Invalid userscript", false)
				return
			}
			os.MkdirAll(l.scriptsDir, 0755)
			e := os.WriteFile(filepath.Join(l.scriptsDir, fn), []byte(src), 0644)
			if e == nil {
				l.load()
				l.reply(c, "__teamsmonkeyDownloadScriptResult", id, map[string]interface{}{"filename": fn}, true)
			} else {
				l.reply(c, "__teamsmonkeyDownloadScriptResult", id, e, false)
			}
		} else {
			if filepath.Base(fn) != fn || !strings.HasSuffix(fn, ".user.js") {
				l.reply(c, "__teamsmonkeyRemoveScriptResult", id, "Invalid filename", false)
				return
			}
			e := os.Remove(filepath.Join(l.scriptsDir, fn))
			if e == nil {
				l.load()
				l.reply(c, "__teamsmonkeyRemoveScriptResult", id, map[string]interface{}{"filename": fn}, true)
			} else {
				l.reply(c, "__teamsmonkeyRemoveScriptResult", id, e, false)
			}
		}
	case dirsBind:
		action := fmt.Sprint(q["action"])
		p := fmt.Sprint(q["path"])
		var e error
		if action == "add" {
			p, _ = filepath.Abs(strings.TrimSpace(p))
			if st, x := os.Stat(p); x != nil || !st.IsDir() {
				e = errors.New("The path is not a directory")
			} else {
				found := false
				for _, d := range l.dirs {
					if d == p {
						found = true
					}
				}
				if !found {
					l.dirs = append(l.dirs, p)
					l.saveDirs()
					l.load()
				}
			}
		} else if action == "remove" {
			p, _ = filepath.Abs(p)
			x := []string{}
			for _, d := range l.dirs {
				if d != p {
					x = append(x, d)
				}
			}
			l.dirs = x
			l.saveDirs()
			l.load()
		} else if action != "list" {
			e = errors.New("Unknown directory action")
		}
		if e != nil {
			l.reply(c, "__teamsmonkeyScriptDirectoriesResult", id, e, false)
		} else {
			l.reply(c, "__teamsmonkeyScriptDirectoriesResult", id, map[string]interface{}{"directories": l.dirs}, true)
		}
	}
}
func (l *Loader) targets() (string, []Target, error) {
	hosts := []string{"127.0.0.1", "[::1]"}
	if l.host != "" {
		hosts = []string{l.host}
	}
	var es []string
	for _, h := range hosts {
		r, e := http.Get("http://" + h + ":" + l.port + "/json/list")
		if e != nil {
			es = append(es, e.Error())
			continue
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode/100 != 2 {
			continue
		}
		var all []Target
		json.Unmarshal(b, &all)
		hit := false
		for _, t := range all {
			if strings.Contains(strings.ToLower(t.Title+" "+t.URL), strings.ToLower(l.target)) {
				hit = true
			}
		}
		if hit {
			out := []Target{}
			for _, t := range all {
				if t.Type == "page" || t.Type == "iframe" {
					out = append(out, t)
				}
			}
			return h, out, nil
		}
	}
	return "", nil, errors.New(strings.Join(es, "; "))
}
func (l *Loader) reconcile() error {
	l.load()
	host, ts, e := l.targets()
	if e != nil {
		return e
	}
	match := []Target{}
	for _, t := range ts {
		ok := strings.Contains(strings.ToLower(t.Title+" "+t.URL), strings.ToLower(l.target))
		for _, s := range l.scripts {
			ok = ok || applies(s, t.URL)
		}
		if ok {
			match = append(match, t)
		}
	}
	live := map[string]bool{}
	for _, t := range match {
		live[t.ID] = true
	}
	for id, c := range l.conns {
		if !live[id] {
			c.ws.Close()
			delete(l.conns, id)
		}
	}
	disabled := map[string][]string{}
	for _, t := range match {
		c := l.conns[t.ID]
		if c != nil && !strings.HasPrefix(t.URL, "https://outlook.office.com/hosted/calendar/") {
			if r, x := l.request(c, "Runtime.evaluate", map[string]interface{}{"expression": `(() => { try { const value = JSON.parse(localStorage.getItem("teams.userscripts.disabled") ?? "[]"); return Array.isArray(value) ? value : []; } catch (_) { return []; } })()`, "returnByValue": true}); x == nil {
				if rr, ok := r["result"].(map[string]interface{}); ok {
					if values, ok := rr["value"].([]interface{}); ok {
						for _, value := range values {
							if name, ok := value.(string); ok {
								disabled[t.ID] = append(disabled[t.ID], name)
							}
						}
					}
				}
			}
		}
	}
	for _, t := range match {
		c := l.conns[t.ID]
		if c == nil {
			wsURL, parseErr := url.Parse(t.WS)
			if parseErr != nil {
				fmt.Fprintf(os.Stderr, "Could not attach to %q (%s): invalid WebSocket URL %q: %v\n", t.Title, t.URL, t.WS, parseErr)
				continue
			}
			wsURL.Host = host + ":" + l.port
			ws := wsURL.String()
			c, e = connect(l, ws)
			if e != nil {
				fmt.Fprintf(os.Stderr, "Could not attach to %q (%s): %v\n", t.Title, t.URL, e)
				continue
			}
			l.conns[t.ID] = c
			fmt.Printf("Attached to %q (%s)\n", t.Title, t.URL)
		}
		if !strings.HasPrefix(t.URL, "https://outlook.office.com/hosted/calendar/") {
			if r, x := l.request(c, "Runtime.evaluate", map[string]interface{}{"expression": `(() => { try { const value = JSON.parse(localStorage.getItem("teams.userscripts.disabled") ?? "[]"); return Array.isArray(value) ? value : []; } catch (_) { return []; } })()`, "returnByValue": true}); x == nil {
				if rr, ok := r["result"].(map[string]interface{}); ok {
					if values, ok := rr["value"].([]interface{}); ok {
						for _, value := range values {
							if name, ok := value.(string); ok {
								disabled[t.ID] = append(disabled[t.ID], name)
							}
						}
					}
				}
			}
		}
		if c.revision != l.rev {
			if e := l.install(c, t, disabled[t.ID]); e != nil {
				fmt.Fprintf(os.Stderr, "Could not inject into %q (%s): %v\n", t.Title, t.URL, e)
				continue
			}
			for _, s := range l.scripts {
				if applies(s, t.URL) {
					fmt.Printf("Injected %q into %q\n", s.Name, t.Title)
				}
			}
		}
	}
	return nil
}

func manageService(install bool) error {
	if runtime.GOOS == "windows" {
		return manageWindowsService(install)
	}
	if runtime.GOOS != "darwin" {
		return errors.New("service management is only supported on macOS and Windows")
	}
	if install && !cdpConfiguredOrRunning() {
		return errors.New("Teams is not configured for CDP and is not currently exposing CDP on port 9223.\n\n" +
			"To enable CDP, run:\n" +
			"  launchctl setenv WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS --remote-debugging-port=9223\n" +
			"Then fully quit Teams, reopen it, and run `make install` again.")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home directory: %w", err)
	}
	uid := os.Getuid()
	agents := filepath.Join(home, "Library", "LaunchAgents")
	logs := filepath.Join(home, "Library", "Logs", "teamsmonkey")
	if err := os.MkdirAll(agents, 0755); err != nil {
		return fmt.Errorf("create launch agents directory: %w", err)
	}
	if err := os.MkdirAll(logs, 0755); err != nil {
		return fmt.Errorf("create log directory: %w", err)
	}
	labels := []string{"com.teamsmonkey.env", "com.teamsmonkey.loader"}
	legacy := []string{"com.guyfaux.teams-userscript-env", "com.guyfaux.teams-userscript-loader", "com.guyfaux.teamsmonkey-env", "com.guyfaux.teamsmonkey-loader"}
	for _, label := range append(labels, legacy...) {
		if err := launchctl([]string{"bootout", fmt.Sprintf("gui/%d/%s", uid, label)}, true); err != nil {
			return err
		}
		if err := removeIfPresent(filepath.Join(agents, label+".plist")); err != nil {
			return err
		}
	}
	if !install {
		if err := launchctl([]string{"unsetenv", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"}, false); err != nil {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve loader executable: %w", err)
	}
	scripts := os.Getenv("TEAMSMONKEY_SCRIPT_PATH")
	if scripts == "" {
		scripts = optionDefaults().scriptsDir
	}
	envPlist := `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.teamsmonkey.env</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS</string><string>--remote-debugging-port=9223</string></array><key>RunAtLoad</key><true/></dict></plist>`
	loaderPlist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.teamsmonkey.loader</string><key>ProgramArguments</key><array><string>%s</string><string>--port</string><string>9223</string><string>--scripts</string><string>%s</string></array><key>WorkingDirectory</key><string>%s</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string></dict></plist>`, xmlEscape(exe), xmlEscape(scripts), xmlEscape(filepath.Dir(exe)), xmlEscape(filepath.Join(logs, "loader.log")), xmlEscape(filepath.Join(logs, "loader-error.log")))
	for label, content := range map[string]string{labels[0]: envPlist, labels[1]: loaderPlist} {
		path := filepath.Join(agents, label+".plist")
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
		if err := launchctl([]string{"bootstrap", fmt.Sprintf("gui/%d", uid), path}, false); err != nil {
			return err
		}
	}
	return launchctl([]string{"setenv", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9223"}, false)
}

func cdpConfiguredOrRunning() bool {
	if strings.Contains(os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"), "--remote-debugging-port") {
		return true
	}
	if output, err := exec.Command("/bin/launchctl", "getenv", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").Output(); err == nil && strings.Contains(string(output), "--remote-debugging-port") {
		return true
	}
	client := http.Client{Timeout: time.Second}
	response, err := client.Get("http://127.0.0.1:" + cdpPort + "/json/version")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices
}

const windowsTaskName = "Teamsmonkey"

func manageWindowsService(install bool) error {
	if install && !windowsCDPConfiguredOrRunning() {
		return errors.New("Teams is not configured for CDP and is not currently exposing CDP on port 9223.\n\n" +
			"To enable CDP in Windows PowerShell, run:\n" +
			"  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '--remote-debugging-port=9223', 'User')\n" +
			"Then fully quit and reopen Teams, and run `make install` again.")
	}
	if err := windowsSchtasks("/Delete", "/TN", windowsTaskName, "/F"); err != nil && !strings.Contains(strings.ToLower(err.Error()), "cannot find") && !strings.Contains(strings.ToLower(err.Error()), "does not exist") {
		return err
	}
	if !install {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve loader executable: %w", err)
	}
	scripts := os.Getenv("TEAMSMONKEY_SCRIPT_PATH")
	if scripts == "" {
		scripts = optionDefaults().scriptsDir
	}
	command := fmt.Sprintf(`"%s" --port 9223 --scripts "%s"`, exe, scripts)
	if err := windowsSchtasks("/Create", "/SC", "ONLOGON", "/TN", windowsTaskName, "/TR", command, "/RL", "LIMITED", "/F"); err != nil {
		return err
	}
	return nil
}

func windowsCDPConfiguredOrRunning() bool {
	if strings.Contains(os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"), "--remote-debugging-port") {
		return true
	}
	if output, err := exec.Command("reg", "query", `HKCU\Environment`, "/v", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").Output(); err == nil && strings.Contains(string(output), "--remote-debugging-port") {
		return true
	}
	client := http.Client{Timeout: time.Second}
	response, err := client.Get("http://127.0.0.1:" + cdpPort + "/json/version")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices
}

func windowsSchtasks(args ...string) error {
	cmd := exec.Command("schtasks.exe", args...)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(output))
	if detail == "" {
		detail = err.Error()
	}
	return fmt.Errorf("schtasks %s failed: %s", strings.Join(args, " "), detail)
}

func launchctl(args []string, allowNotLoaded bool) error {
	cmd := exec.Command("/bin/launchctl", args...)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if allowNotLoaded {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 3 {
			return nil
		}
	}
	detail := strings.TrimSpace(string(output))
	if detail == "" {
		detail = err.Error()
	}
	return fmt.Errorf("launchctl %s failed: %s", strings.Join(args, " "), detail)
}
func removeIfPresent(path string) error {
	err := os.Remove(path)
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return fmt.Errorf("remove %s: %w", path, err)
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;").Replace(s)
}

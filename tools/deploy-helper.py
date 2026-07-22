#!/usr/bin/env python3
"""
EuroBureau Deploy Helper
A Tkinter-based GUI for running deployment commands over SSH.
"""

import tkinter as tk
from tkinter import ttk, messagebox
import paramiko
import threading
import subprocess
import os
import re
from datetime import datetime

# Regex to strip ANSI escape sequences
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[#=<>]")

# === Configuration ===

ENVIRONMENTS = {
    "dev-proxy": {
        "host": "167.233.233.123",
        "user": "root",
        "label": "Dev Proxy",
    },
    "dev-app-a": {
        "host": "128.140.88.63",
        "user": "root",
        "label": "Dev App A",
    },
    "dev-app-b": {
        "host": "178.105.119.64",
        "user": "root",
        "label": "Dev App B",
    },
    "dev-db": {
        "host": "167.233.233.99",
        "user": "root",
        "label": "Dev DB",
    },
    "prod-proxy": {
        "host": "188.245.126.65",
        "user": "root",
        "label": "Prod Proxy",
    },
    "prod-app-a": {
        "host": "138.201.244.235",
        "user": "root",
        "label": "Prod App A",
    },
    "prod-app-b": {
        "host": "167.233.236.127",
        "user": "root",
        "label": "Prod App B",
    },
    "prod-db": {
        "host": "162.55.44.102",
        "user": "root",
        "label": "Prod DB",
    },
}

# Multi-server topology for rolling deploys
MULTI_SERVER = {
    "dev": {
        "proxy": "dev-proxy",
        "apps": ["dev-app-a", "dev-app-b"],
        "db": "dev-db",
        "private_ips": {
            "dev-app-a": "10.0.1.11",
            "dev-app-b": "10.0.1.12",
        },
        "compose_file": "docker-compose.multi.yml",
        "nginx_upstream": "app_backends",
        "nginx_conf": "/etc/nginx/sites-available/dev.conf",
    },
    "prod": {
        "proxy": "prod-proxy",
        "apps": ["prod-app-a", "prod-app-b"],
        "db": "prod-db",
        "private_ips": {
            "prod-app-a": "10.0.0.11",
            "prod-app-b": "10.0.0.12",
        },
        "compose_file": "docker-compose.multi.yml",
        "nginx_upstream": "app_backends",
        "nginx_conf": "/etc/nginx/sites-available/eurobureau.conf",
    },
}

# Commands are lists of (description, shell_command) tuples.
# They run sequentially in a single SSH session.
ACTIONS = {
    "Blue-Green (Dev)": {
        "targets": ["dev-proxy", "dev-app-a", "dev-app-b", "dev-db", "prod-proxy", "prod-app-a", "prod-app-b", "prod-db"],
        "special": "bluegreen_deploy",
        "environment": "dev",
    },
    "Blue-Green (Prod)": {
        "targets": ["dev-proxy", "dev-app-a", "dev-app-b", "dev-db", "prod-proxy", "prod-app-a", "prod-app-b", "prod-db"],
        "special": "bluegreen_deploy",
        "environment": "prod",
    },
    "Blue-Green no cache (Dev)": {
        "targets": ["dev-proxy", "dev-app-a", "dev-app-b", "dev-db", "prod-proxy", "prod-app-a", "prod-app-b", "prod-db"],
        "special": "bluegreen_deploy",
        "environment": "dev",
        "no_cache": True,
    },
    "Blue-Green no cache (Prod)": {
        "targets": ["dev-proxy", "dev-app-a", "dev-app-b", "dev-db", "prod-proxy", "prod-app-a", "prod-app-b", "prod-db"],
        "special": "bluegreen_deploy",
        "environment": "prod",
        "no_cache": True,
    },
    "Update Fonts (Dev)": {
        "targets": ["dev-app-a", "dev-app-b"],
        "commands": [
            "cd /opt/euro-office/repo/fonts && git checkout main && git pull",
            "cd /opt/euro-office/repo/deploy && docker compose -f docker-compose.multi.yml build --no-cache documentserver",
            "cd /opt/euro-office/repo/deploy && docker compose -f docker-compose.multi.yml up -d documentserver",
        ],
    },
    "Update Fonts (Prod)": {
        "targets": ["prod-app-a", "prod-app-b"],
        "commands": [
            "cd /opt/euro-office/repo/fonts && git checkout main && git pull",
            "cd /opt/euro-office/repo/deploy && docker compose -f docker-compose.multi.yml build --no-cache documentserver",
            "cd /opt/euro-office/repo/deploy && docker compose -f docker-compose.multi.yml up -d documentserver",
        ],
    },
    "View Logs": {
        "targets": ["dev-app-a", "dev-app-b", "prod-app-a", "prod-app-b"],
        "special": "stream_logs",
        "command": "cd /opt/euro-office/repo/deploy && docker compose -f docker-compose.multi.yml logs portal -t --tail 100 -f",
    },
    "Update Proxy Config (Prod)": {
        "targets": ["prod-proxy"],
        "special": "proxy_update",
        "nginx_conf": "deploy/nginx/nginx-proxy-prod.conf",
        "nginx_dest": "/etc/nginx/sites-available/eurobureau.conf",
        "certbot_domain": "eurobureau.eu",
    },
    "Update Proxy Config (Dev)": {
        "targets": ["dev-proxy"],
        "special": "proxy_update",
        "nginx_conf": "deploy/nginx/nginx-proxy-dev.conf",
        "nginx_dest": "/etc/nginx/sites-available/dev.conf",
        "certbot_domain": "dev.eurobureau.eu",
    },
    "Database Shell": {
        "targets": ["dev-db", "prod-db"],
        "special": "db_shell",
    },
    "Build Web Apps": {
        "targets": ["dev-proxy", "dev-app-a", "dev-app-b", "dev-db", "prod", "prod-proxy"],
        "special": "local_command",
        "command": "./tools/build-web-apps.sh",
    },
}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class DeployHelper:
    def __init__(self, root):
        self.root = root
        self.root.title("EuroBureau Deploy Helper")
        self.root.geometry("900x620")
        self.root.minsize(700, 500)

        self.running = False
        self.current_thread = None

        self._build_ui()

    def _build_ui(self):
        # Top frame: environment + action selection
        top_frame = ttk.Frame(self.root, padding=10)
        top_frame.pack(fill=tk.X)

        ttk.Label(top_frame, text="Environment:").pack(side=tk.LEFT, padx=(0, 5))
        self.env_var = tk.StringVar(value="dev-proxy")
        env_menu = ttk.Combobox(
            top_frame,
            textvariable=self.env_var,
            values=list(ENVIRONMENTS.keys()),
            state="readonly",
            width=12,
        )
        env_menu.pack(side=tk.LEFT, padx=(0, 15))
        env_menu.bind("<<ComboboxSelected>>", self._on_env_change)

        ttk.Label(top_frame, text="Action:").pack(side=tk.LEFT, padx=(0, 5))
        self.action_var = tk.StringVar(value=list(ACTIONS.keys())[0])
        self.action_menu = ttk.Combobox(
            top_frame,
            textvariable=self.action_var,
            values=self._get_available_actions(),
            state="readonly",
            width=20,
        )
        self.action_menu.pack(side=tk.LEFT, padx=(0, 15))

        self.run_btn = ttk.Button(top_frame, text="Run", command=self._run_action)
        self.run_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.stop_btn = ttk.Button(
            top_frame, text="Stop", command=self._stop_action, state=tk.DISABLED
        )
        self.stop_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.clear_btn = ttk.Button(
            top_frame, text="Clear", command=self._clear_output
        )
        self.clear_btn.pack(side=tk.RIGHT)

        # Status bar
        status_frame = ttk.Frame(self.root, padding=(10, 0))
        status_frame.pack(fill=tk.X)
        self.status_var = tk.StringVar(value="Ready")
        self.status_label = ttk.Label(
            status_frame, textvariable=self.status_var, foreground="gray"
        )
        self.status_label.pack(side=tk.LEFT)

        # Console output
        console_frame = ttk.Frame(self.root, padding=10)
        console_frame.pack(fill=tk.BOTH, expand=True)

        self.console = tk.Text(
            console_frame,
            bg="#1e1e1e",
            fg="#d4d4d4",
            font=("Consolas", 10),
            wrap=tk.WORD,
            state=tk.DISABLED,
            insertbackground="#d4d4d4",
        )
        scrollbar = ttk.Scrollbar(console_frame, command=self.console.yview)
        self.console.configure(yscrollcommand=scrollbar.set)

        self.console.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Text tags for coloring
        self.console.tag_configure("info", foreground="#569cd6")
        self.console.tag_configure("success", foreground="#6a9955")
        self.console.tag_configure("error", foreground="#f44747")
        self.console.tag_configure("command", foreground="#dcdcaa")
        self.console.tag_configure("timestamp", foreground="#808080")

    def _get_available_actions(self):
        env = self.env_var.get()
        return [name for name, cfg in ACTIONS.items() if env in cfg["targets"]]

    def _on_env_change(self, event=None):
        available = self._get_available_actions()
        self.action_menu.configure(values=available)
        if self.action_var.get() not in available:
            self.action_var.set(available[0] if available else "")

    def _log(self, text, tag=None):
        """Append text to console (thread-safe via .after)."""
        def _append():
            self.console.configure(state=tk.NORMAL)
            if tag:
                self.console.insert(tk.END, text, tag)
            else:
                self.console.insert(tk.END, text)
            self.console.see(tk.END)
            self.console.configure(state=tk.DISABLED)

        self.root.after(0, _append)

    def _log_stream(self, raw_data, tag=None):
        """
        Append streaming data to console, handling:
        - ANSI escape stripping
        - Carriage return (\\r) overwrites the last line (progress bars)
        """
        clean = ANSI_ESCAPE.sub("", raw_data)

        # Normalize \r\n to \n, then handle standalone \r
        clean = clean.replace("\r\n", "\n")

        def _append():
            self.console.configure(state=tk.NORMAL)

            # Process character by character logic for \r
            # Split on \n first to get real lines
            lines = clean.split("\n")

            for line_idx, line in enumerate(lines):
                if line_idx > 0:
                    # This came after a \n, so start a new line
                    self.console.insert(tk.END, "\n")

                if "\r" in line:
                    # Multiple \r-separated segments: only show the last one
                    # (earlier segments were "overwritten" by later ones)
                    segments = line.split("\r")
                    final = segments[-1]
                    if final:
                        if tag:
                            self.console.insert(tk.END, final, tag)
                        else:
                            self.console.insert(tk.END, final)
                else:
                    if line:
                        if tag:
                            self.console.insert(tk.END, line, tag)
                        else:
                            self.console.insert(tk.END, line)

            self.console.see(tk.END)
            self.console.configure(state=tk.DISABLED)

        self.root.after(0, _append)

    def _log_header(self, text):
        ts = datetime.now().strftime("%H:%M:%S")
        self._log(f"[{ts}] ", "timestamp")
        self._log(f"{text}\n", "info")

    def _log_cmd(self, cmd):
        self._log(f"$ {cmd}\n", "command")

    def _set_status(self, text, color="gray"):
        def _update():
            self.status_var.set(text)
            self.status_label.configure(foreground=color)

        self.root.after(0, _update)

    def _set_running(self, running):
        self.running = running

        def _update():
            if running:
                self.run_btn.configure(state=tk.DISABLED)
                self.stop_btn.configure(state=tk.NORMAL)
            else:
                self.run_btn.configure(state=tk.NORMAL)
                self.stop_btn.configure(state=tk.DISABLED)

        self.root.after(0, _update)

    def _clear_output(self):
        self.console.configure(state=tk.NORMAL)
        self.console.delete("1.0", tk.END)
        self.console.configure(state=tk.DISABLED)

    def _run_action(self):
        env_key = self.env_var.get()
        action_name = self.action_var.get()

        if not env_key or not action_name:
            messagebox.showwarning("Missing selection", "Select an environment and action.")
            return

        action = ACTIONS[action_name]
        env = ENVIRONMENTS[env_key]

        self._set_running(True)
        self._log_header(f"Running '{action_name}' on {env['label']} ({env['host']})")

        if action.get("special") == "proxy_update":
            self.current_thread = threading.Thread(
                target=self._run_proxy_update, args=(env, action.get("nginx_conf"), action.get("nginx_dest"), action.get("certbot_domain")), daemon=True
            )
        elif action.get("special") == "stream_logs":
            self.current_thread = threading.Thread(
                target=self._run_stream_command,
                args=(env, action["command"]),
                daemon=True,
            )
        elif action.get("special") == "db_shell":
            self.current_thread = threading.Thread(
                target=self._run_db_shell, args=(env,), daemon=True
            )
        elif action.get("special") == "local_command":
            self.current_thread = threading.Thread(
                target=self._run_local_command, args=(action["command"],), daemon=True
            )
        elif action.get("special") == "bluegreen_deploy":
            self.current_thread = threading.Thread(
                target=self._run_bluegreen_deploy, args=(action["environment"], action.get("no_cache", False)), daemon=True
            )
        else:
            self.current_thread = threading.Thread(
                target=self._run_ssh_commands,
                args=(env, action["commands"]),
                daemon=True,
            )
        self.current_thread.start()

    def _stop_action(self):
        self.running = False
        self._set_status("Stopping...", "orange")

    def _get_ssh_client(self, env):
        """Create and connect an SSH client using local keys."""
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=env["host"],
            username=env["user"],
            look_for_keys=True,
            allow_agent=True,
            timeout=10,
        )
        return client

    def _run_ssh_commands(self, env, commands):
        """Execute a list of commands over SSH, streaming output."""
        try:
            self._set_status(f"Connecting to {env['host']}...", "orange")
            client = self._get_ssh_client(env)
            self._set_status(f"Connected to {env['host']}", "green")

            for cmd in commands:
                if not self.running:
                    self._log("\n⚠ Stopped by user.\n", "error")
                    break

                self._log_cmd(cmd)
                stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)

                # Stream stdout
                for line in iter(stdout.readline, ""):
                    if not self.running:
                        break
                    self._log_stream(line)

                # Capture stderr
                err = stderr.read().decode()
                if err.strip():
                    self._log_stream(err, "error")

                exit_code = stdout.channel.recv_exit_status()
                if exit_code != 0:
                    self._log(f"\n✗ Command exited with code {exit_code}\n", "error")
                    self._set_status("Failed", "red")
                    break
                else:
                    self._log(f"✓ Done\n", "success")

            else:
                self._log("\n✓ All commands completed successfully.\n", "success")
                self._set_status("Done", "green")

            client.close()

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_proxy_update(self, env, nginx_conf_rel=None, nginx_dest=None, certbot_domain=None):
        """Handle proxy config update: SCP files, reload nginx, re-install certbot SSL."""
        try:
            self._set_status("Uploading config files...", "orange")

            nginx_src = os.path.join(REPO_ROOT, nginx_conf_rel) if nginx_conf_rel else os.path.join(REPO_ROOT, "deploy", "nginx", "nginx.conf")
            dest_path = nginx_dest or "/etc/nginx/sites-available/eurobureau.conf"
            refresh_script_src = os.path.join(REPO_ROOT, "deploy", "scripts", "refresh-cidrs-nginx.sh")
            host = env["host"]
            user = env["user"]

            client = self._get_ssh_client(env)
            sftp = client.open_sftp()

            # SCP nginx.conf
            self._log_cmd(
                f"scp {nginx_src} {user}@{host}:{dest_path}"
            )
            sftp.put(nginx_src, dest_path)
            self._log("✓ Uploaded nginx.conf\n", "success")

            # SCP refresh-cidrs-nginx.sh
            self._log_cmd(
                f"scp {refresh_script_src} {user}@{host}:/usr/local/bin/refresh-cidrs-nginx.sh"
            )
            sftp.put(refresh_script_src, "/usr/local/bin/refresh-cidrs-nginx.sh")
            self._log("✓ Uploaded refresh-cidrs-nginx.sh\n", "success")

            sftp.close()

            # Make script executable and run it (creates /etc/nginx/geo-whitelist.conf)
            if self.running:
                self._log_cmd("chmod +x /usr/local/bin/refresh-cidrs-nginx.sh && /usr/local/bin/refresh-cidrs-nginx.sh")
                stdin, stdout, stderr = client.exec_command(
                    "chmod +x /usr/local/bin/refresh-cidrs-nginx.sh && /usr/local/bin/refresh-cidrs-nginx.sh",
                    get_pty=True
                )
                for line in iter(stdout.readline, ""):
                    if not self.running:
                        break
                    self._log_stream(line)
                err = stderr.read().decode()
                if err.strip():
                    self._log_stream(err, "error")

                exit_code = stdout.channel.recv_exit_status()
                if exit_code == 0:
                    self._log("✓ Geo-whitelist refreshed and nginx reloaded\n", "success")
                    self._set_status("Done", "green")
                else:
                    self._log(f"\n✗ Refresh script failed (code {exit_code})\n", "error")
                    # Try a plain nginx reload in case the whitelist already exists
                    self._log_cmd("nginx -t && nginx -s reload")
                    stdin, stdout, stderr = client.exec_command(
                        "nginx -t && nginx -s reload", get_pty=True
                    )
                    for line in iter(stdout.readline, ""):
                        self._log_stream(line)
                    reload_exit = stdout.channel.recv_exit_status()
                    if reload_exit == 0:
                        self._log("\n✓ Nginx reloaded (whitelist script failed but config is valid).\n", "success")
                        self._set_status("Done (with warnings)", "orange")
                    else:
                        self._log(f"\n✗ Nginx reload also failed (code {reload_exit})\n", "error")
                        self._set_status("Failed", "red")

            # Re-install certbot SSL certificate for the domain
            if self.running and certbot_domain:
                self._log(f"\n→ Re-installing certbot SSL for {certbot_domain}...\n", "info")
                certbot_cmd = f"certbot --nginx -d {certbot_domain} --non-interactive --agree-tos --redirect"
                self._log_cmd(certbot_cmd)
                stdin, stdout, stderr = client.exec_command(certbot_cmd, get_pty=True)
                for line in iter(stdout.readline, ""):
                    if not self.running:
                        break
                    self._log_stream(line)
                err = stderr.read().decode()
                if err.strip():
                    self._log_stream(err, "error")
                certbot_exit = stdout.channel.recv_exit_status()
                if certbot_exit == 0:
                    self._log("✓ Certbot SSL installed\n", "success")
                else:
                    self._log(f"\n✗ Certbot failed (code {certbot_exit})\n", "error")
                    self._set_status("Done (SSL failed)", "orange")

            client.close()

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_stream_command(self, env, command):
        """Run a long-lived streaming command (like log tailing). Stops on user cancel."""
        try:
            self._set_status(f"Connecting to {env['host']}...", "orange")
            client = self._get_ssh_client(env)
            self._set_status(f"Streaming logs from {env['host']}...", "green")

            self._log_cmd(command)
            transport = client.get_transport()
            channel = transport.open_session()
            channel.get_pty()
            channel.exec_command(command)

            # Read output in a loop until stopped
            while self.running:
                if channel.recv_ready():
                    data = channel.recv(4096).decode("utf-8", errors="replace")
                    if data:
                        self._log_stream(data)
                elif channel.exit_status_ready():
                    # Command ended on its own
                    break
                else:
                    # Small sleep to avoid busy-waiting
                    import time
                    time.sleep(0.1)

            # Drain any remaining output
            while channel.recv_ready():
                data = channel.recv(4096).decode("utf-8", errors="replace")
                if data:
                    self._log_stream(data)

            channel.close()
            client.close()

            if not self.running:
                self._log("\n⚠ Stream stopped by user.\n", "info")
            self._set_status("Done", "green")

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_db_shell(self, env):
        """Open an interactive psql session on the DB server."""
        try:
            host = env["host"]
            user = env["user"]

            # For multi-server: connect to psql directly on the DB server
            # For prod (single server): use docker exec
            if "db" in env.get("label", "").lower():
                cmd = f"ssh -t {user}@{host} 'sudo -u postgres psql portal'"
            else:
                cmd = f"ssh -t {user}@{host} 'cd /opt/euro-office/repo/deploy && docker compose exec postgres psql -U portal portal'"

            self._log_header(f"Opening database shell on {env['label']}")
            self._log_cmd(cmd)
            self._log("Launching in external terminal...\n", "info")

            terminals = [
                ["x-terminal-emulator", "-e"],
                ["gnome-terminal", "--"],
                ["konsole", "-e"],
                ["xfce4-terminal", "-e"],
                ["xterm", "-e"],
            ]

            launched = False
            for term_cmd in terminals:
                try:
                    subprocess.Popen(term_cmd + ["bash", "-c", cmd])
                    launched = True
                    self._log(f"✓ Opened in {term_cmd[0]}\n", "success")
                    break
                except FileNotFoundError:
                    continue

            if not launched:
                self._log("Could not find a terminal emulator. Run manually:\n", "error")
                self._log(f"  {cmd}\n", "command")

            self._set_status("Done", "green")

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_local_command(self, command):
        """Run a local command and stream its output."""
        try:
            self._set_status("Running local command...", "orange")
            self._log_cmd(command)

            process = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=REPO_ROOT,
                text=True,
            )

            for line in iter(process.stdout.readline, ""):
                if not self.running:
                    process.terminate()
                    self._log("\n⚠ Stopped by user.\n", "error")
                    break
                self._log(line)

            process.wait()
            if process.returncode == 0:
                self._log("\n✓ Done.\n", "success")
                self._set_status("Done", "green")
            else:
                self._log(f"\n✗ Exited with code {process.returncode}\n", "error")
                self._set_status("Failed", "red")

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

    def _run_bluegreen_deploy(self, environment, no_cache=False):
        """
        Blue-green deploy:
        1. Determine which server is currently active (receiving traffic)
        2. Upgrade the IDLE server
        3. Force-save on the ACTIVE server
        4. Flip proxy to the freshly-upgraded idle server
        5. Upgrade the now-idle former-active server
        Result: both servers upgraded, zero data loss, minimal disruption.
        """
        import time

        try:
            topology = MULTI_SERVER.get(environment)
            if not topology:
                self._log(f"No multi-server topology defined for '{environment}'\n", "error")
                self._set_status("Failed", "red")
                return

            proxy_env = ENVIRONMENTS[topology["proxy"]]
            app_keys = topology["apps"]
            compose_file = topology["compose_file"]
            private_ips = topology["private_ips"]
            nginx_conf = topology["nginx_conf"]

            self._set_status("Blue-green deploy in progress...", "orange")
            self._log_header(f"Blue-green deploy to {environment}")

            # Determine which server is currently active by checking nginx config
            self._log("→ Detecting active server...\n", "info")
            client = self._get_ssh_client(proxy_env)
            stdin, stdout, stderr = client.exec_command(f"cat {nginx_conf}")
            nginx_content = stdout.read().decode()
            client.close()

            # Find which servers are NOT commented out
            active_key = None
            idle_key = None
            for app_key in app_keys:
                ip = private_ips[app_key]
                # If the line is commented, this server is idle
                if f"# server {ip}" in nginx_content:
                    idle_key = app_key
                else:
                    active_key = app_key

            # If both are active (first deploy or normal state), 
            # comment out B to establish blue-green baseline
            if idle_key is None:
                self._log("  Both servers active — establishing blue-green baseline...\n", "info")
                idle_key = app_keys[1]
                active_key = app_keys[0]
                # Comment out idle server in nginx
                idle_ip_init = private_ips[idle_key]
                client = self._get_ssh_client(proxy_env)
                stdin, stdout, stderr = client.exec_command(
                    f"sed -i 's|server {idle_ip_init}:80;|# server {idle_ip_init}:80; # draining|' "
                    f"{nginx_conf} && nginx -s reload"
                )
                stdout.channel.recv_exit_status()
                client.close()
                self._log(f"  ✓ Baseline set: {ENVIRONMENTS[active_key]['label']} active, {ENVIRONMENTS[idle_key]['label']} idle\n", "success")

            active_env = ENVIRONMENTS[active_key]
            idle_env = ENVIRONMENTS[idle_key]
            active_ip = private_ips[active_key]
            idle_ip = private_ips[idle_key]

            self._log(f"  Active: {active_env['label']} ({active_ip})\n", "info")
            self._log(f"  Idle:   {idle_env['label']} ({idle_ip})\n", "info")

            if not self.running:
                return

            # Step 1: Upgrade the idle server
            self._log(f"\n→ Upgrading idle server ({idle_env['label']})...\n", "info")
            client = self._get_ssh_client(idle_env)
            build_cmd = (
                f"cd /opt/euro-office/repo/deploy && docker compose -f {compose_file} build --no-cache && "
                f"docker compose -f {compose_file} up -d"
            ) if no_cache else (
                f"cd /opt/euro-office/repo/deploy && docker compose -f {compose_file} down && "
                f"docker compose -f {compose_file} up -d --build"
            )
            commands = [
                "cd /opt/euro-office/repo && git fetch && git checkout main && git pull && git submodule update --init fonts",
                build_cmd,
                f"cd /opt/euro-office/repo/deploy && docker compose -f {compose_file} exec -T portal node dist/db/migrate.js",
            ]
            for cmd in commands:
                if not self.running:
                    break
                self._log_cmd(cmd)
                stdin, stdout, stderr = client.exec_command(cmd)
                for line in iter(stdout.readline, ""):
                    if not self.running:
                        break
                    self._log_stream(line)
                exit_code = stdout.channel.recv_exit_status()
                if exit_code != 0:
                    self._log(f"  ✗ Command failed (code {exit_code})\n", "error")
            client.close()
            self._log(f"  ✓ {idle_env['label']} upgraded\n", "success")

            if not self.running:
                return

            # Step 2: Wait for idle server health check
            self._log(f"\n→ Waiting for {idle_env['label']} health check...\n", "info")
            healthy = False
            for attempt in range(60):
                time.sleep(2)
                try:
                    client = self._get_ssh_client(idle_env)
                    stdin, stdout, stderr = client.exec_command(
                        f"cd /opt/euro-office/repo/deploy && "
                        f"docker compose -f {compose_file} exec -T documentserver "
                        f"curl -sf http://localhost:80/healthcheck"
                    )
                    exit_code = stdout.channel.recv_exit_status()
                    client.close()
                    if exit_code == 0:
                        healthy = True
                        break
                except Exception:
                    pass
            if not healthy:
                self._log("  ✗ Health check failed after 120s!\n", "error")
                self._set_status("Failed - idle server unhealthy", "red")
                return
            self._log("  ✓ Health check passed\n", "success")

            if not self.running:
                return

            # Step 3: Force-save BEFORE flipping (callback URL still resolves to this server)
            self._log(f"\n→ Force-saving documents on {active_env['label']} (pre-flip)...\n", "info")
            client = self._get_ssh_client(active_env)
            stdin, stdout, stderr = client.exec_command(
                "curl -s -X POST 'http://localhost:80/api/internal/forcesave?strategy=both&concurrency=10'"
            )
            result = stdout.read().decode()
            stdout.channel.recv_exit_status()
            client.close()
            self._log(f"  Response: {result}\n")
            self._log("  ✓ Force save complete\n", "success")

            if not self.running:
                return

            # Step 4: Flip proxy — now safe because all edits are persisted
            self._log(f"\n→ Flipping proxy: {active_env['label']} → {idle_env['label']}...\n", "info")
            client = self._get_ssh_client(proxy_env)
            # Ensure idle is uncommented and active is commented
            flip_cmd = (
                f"sed -i "
                f"'s|server {idle_ip}:80;|server {idle_ip}:80;|; "
                f"s|# server {idle_ip}:80; # draining|server {idle_ip}:80;|; "
                f"s|server {active_ip}:80;|# server {active_ip}:80; # draining|' "
                f"{nginx_conf} && nginx -s reload"
            )
            stdin, stdout, stderr = client.exec_command(flip_cmd)
            stdout.channel.recv_exit_status()
            client.close()
            self._log(f"  ✓ Traffic now going to {idle_env['label']}\n", "success")

            if not self.running:
                return

            # Stop nginx on old active server to kill WebSocket connections (prevents further edits)
            self._log(f"\n→ Stopping nginx on {active_env['label']} (disconnecting users)...\n", "info")
            client = self._get_ssh_client(active_env)
            stdin, stdout, stderr = client.exec_command(
                f"cd /opt/euro-office/repo/deploy && docker compose -f {compose_file} stop nginx"
            )
            stdout.channel.recv_exit_status()
            client.close()
            self._log("  ✓ Users disconnected\n", "success")

            # Second forcesave — DS flushes when websockets disconnect, hit portal directly
            # self._log(f"\n→ Final force-save on {active_env['label']} (post-disconnect)...\n", "info")
            # client = self._get_ssh_client(active_env)
            # stdin, stdout, stderr = client.exec_command(
            #     f"cd /opt/euro-office/repo/deploy && "
            #     f"docker compose -f {compose_file} exec -T portal "
            #     f"node -e \"fetch('http://localhost:3000/api/internal/forcesave?strategy=both&concurrency=10', {{method:'POST'}}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d))).catch(e=>console.error(e))\""
            # )
            # result2 = stdout.read().decode()
            # stdout.channel.recv_exit_status()
            # client.close()
            # self._log(f"  Response: {result2}\n")
            # self._log("  ✓ Final force save complete\n", "success")

            if not self.running:
                return

            # Step 5: Upgrade the former-active (now idle) server
            self._log(f"\n→ Upgrading {active_env['label']} (now idle)...\n", "info")
            client = self._get_ssh_client(active_env)
            for cmd in commands:
                if not self.running:
                    break
                self._log_cmd(cmd)
                stdin, stdout, stderr = client.exec_command(cmd)
                for line in iter(stdout.readline, ""):
                    if not self.running:
                        break
                    self._log_stream(line)
                exit_code = stdout.channel.recv_exit_status()
                if exit_code != 0:
                    self._log(f"  ✗ Command failed (code {exit_code})\n", "error")
            client.close()
            self._log(f"  ✓ {active_env['label']} upgraded (remains idle until next deploy)\n", "success")

            self._log(f"\n✓ Blue-green deploy complete!\n", "success")
            self._log(f"  Active: {idle_env['label']}\n", "info")
            self._log(f"  Idle:   {active_env['label']} (will become active on next deploy)\n", "info")
            self._set_status("Done", "green")

        except Exception as e:
            self._log(f"\n✗ Error: {e}\n", "error")
            self._set_status("Error", "red")
        finally:
            self._set_running(False)

def main():
    root = tk.Tk()
    app = DeployHelper(root)
    root.mainloop()


if __name__ == "__main__":
    main()

"""GCP adapter boundary and single-platform Artifact Registry publishing; credentials stay server-side."""
import json
import os
from pathlib import Path
import re

import httpx

from engine.deployments import DeploymentError, LocalRunner


class GcpRunner(LocalRunner):
    def __init__(self):
        self.base = 'http://127.0.0.1:9103'

    def config(self):
        path = os.environ.get('GCP_ADAPTER_CONFIG')
        if not path:
            raise DeploymentError('GCP requires GCP_ADAPTER_CONFIG on the engine (the same file as the GCP adapter). Prepare Cloud SQL and Artifact Registry first; see infra/gcp/README.md.')
        try:
            config = json.loads(Path(path).read_text())
            project, number, region = config['gcpProject'], config['gcpProjectNumber'], config['region']
            if (not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project) or not re.fullmatch(r'\d{6,20}', number)
                    or region != 'asia-northeast3' or not re.fullmatch(r'[a-z][a-z0-9-]{0,47}[a-z0-9]', config['serviceName'])
                    or not re.fullmatch(rf'{region}-docker\.pkg\.dev/{project}/[a-z0-9][a-z0-9._-]*/', config['imagePrefixes'][0])):
                raise ValueError()
            for key in ('projectId', 'port', 'dbName'): config[key]
            return config
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            raise DeploymentError('Invalid GCP adapter configuration; regenerate it with infra/gcp/scripts/provision.sh.') from None

    def valid_url(self, url):
        config = self.config()
        return url.rstrip('/') == f"https://{config['serviceName']}-{config['gcpProjectNumber']}.{config['region']}.run.app"

    def call(self, method, path, body=None):
        try:
            # DELETE waits for zero instances on the adapter (scale-down operation + up to 15 s public check).
            with httpx.Client(timeout=60 if method == 'DELETE' else 20, trust_env=False) as client:
                response = client.request(method, self.base + path, json=body)
                response.raise_for_status()
                return response.json() if response.content else None
        except (httpx.HTTPError, ValueError):
            raise DeploymentError('GCP Target request failed; inspect the adapter on 127.0.0.1:9103 and its deployment logs.') from None

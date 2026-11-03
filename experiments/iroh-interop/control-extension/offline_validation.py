"""Static preparation checks only; never imports a binding or starts a network."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
PATHS = ['src/endpoint.rs', 'iroh-js/src/endpoint.rs']

class PreparationChecks(unittest.TestCase):
    def test_patch_reproduces_candidates_without_touching_upstream(self):
        with tempfile.TemporaryDirectory(prefix='freelm-iroh-patch-') as temporary:
            target = Path(temporary)
            for relative in PATHS:
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / 'baseline' / relative, destination)
            # Local patch application only: no clone, remote, credentials or hooks.
            subprocess.run(['git', 'apply', '--check', str(ROOT / 'controls.patch')], cwd=target, check=True)
            subprocess.run(['git', 'apply', str(ROOT / 'controls.patch')], cwd=target, check=True)
            for relative in PATHS:
                self.assertEqual((target / relative).read_bytes(), (ROOT / 'candidate' / relative).read_bytes())

    def test_exports_are_symmetric_and_configuration_only(self):
        for relative in PATHS:
            source = (ROOT / 'candidate' / relative).read_text()
            for name, operation in [
                ('clear_ip_transports', 'b.clear_ip_transports()'),
                ('clear_address_lookup', 'b.clear_address_lookup()'),
                ('disable_port_mapping', 'b.portmapper_config(iroh::endpoint::PortmapperConfig::Disabled)'),
            ]:
                start = source.index('    pub fn ' + name + '(&self) {')
                body = source[start:source.index('\n    }', start)]
                self.assertIn('self.map(|b| ' + operation + ');', body)
                self.assertNotIn('.bind(', body)
                if relative.startswith('iroh-js'):
                    self.assertTrue(source[:start].endswith('    #[napi]\n'))

    def test_unbuilt_status_cannot_be_misread_as_network_clearance(self):
        contract = json.loads((ROOT / 'expected-api.json').read_text())
        self.assertFalse(contract['networkAllowed'])
        self.assertIn('NOT regenerated or linked', contract['status'])
        self.assertTrue(any('NetReportConfig' in entry for entry in contract['unresolved']))
        self.assertTrue(any('1.91' in entry for entry in contract['unresolved']))

if __name__ == '__main__':
    unittest.main(verbosity=2)

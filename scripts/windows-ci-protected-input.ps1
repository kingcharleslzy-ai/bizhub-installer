$ErrorActionPreference = 'Stop'
# Native handles pin a flat CI input against writes/renames while it is checked
# and consumed. Canonical paths and link counts reject reparse/hard-link escape.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography.X509Certificates;
public static class BizHubCiInput {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, uint size, uint flags);
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CertVerifySubjectCertificateContext(IntPtr subject, IntPtr issuer, ref uint flags);
    public static bool SelfSigned(X509Certificate2 certificate) {
        uint flags = 1; // Verify the signature against this exact public key.
        return CertVerifySubjectCertificateContext(certificate.Handle, certificate.Handle, ref flags) && flags == 0;
    }
    public static FileStream Open(string path, long maximum) {
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try {
            Info info;
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out info) || info.links != 1 || (info.attributes & 0x410) != 0)
                throw new IOException("ci_input_links_or_reparse_refused");
            var final = new StringBuilder(32768);
            uint count = GetFinalPathNameByHandle(stream.SafeFileHandle, final, (uint)final.Capacity, 0);
            if (count == 0 || count >= final.Capacity || !String.Equals(final.ToString(), @"\\?\" + Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase))
                throw new IOException("ci_input_path_escape_refused");
            if (stream.Length > maximum) throw new IOException("ci_input_too_large");
            return stream;
        } catch { stream.Dispose(); throw; }
    }
    public static byte[] Read(string path, long maximum) {
        using (var stream = Open(path, maximum)) {
            byte[] bytes = new byte[stream.Length];
            int offset = 0, count;
            while (offset < bytes.Length && (count = stream.Read(bytes, offset, bytes.Length - offset)) > 0) offset += count;
            if (offset != bytes.Length) throw new IOException("ci_input_short_read");
            return bytes;
        }
    }
}
'@

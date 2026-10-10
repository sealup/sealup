// TEST ONLY. Certificates for the in-process FTPS server (spec #41 decision 17): never trust
// them anywhere else. Every private key here is public by being committed. One server key
// (EC P-256) under four certificates, made with OpenSSL 3.5 on 2026-10-09, valid until 2126:
//
//   selfSigned  CN=sealup test FTP server, SAN IP:127.0.0.1, signed by itself: fails the CA check
//   trusted     CN=127.0.0.1, SAN IP:127.0.0.1, signed by the test CA: passes it at 127.0.0.1
//               once a test trusts `testCa` (tls.setDefaultCACertificates)
//   otherName   CN=ftp.example.com, SAN DNS:ftp.example.com, signed by the test CA: the CA check
//               passes, the name check at 127.0.0.1 fails (a shared host's certificate)
//   testCa      CN=sealup test CA, the issuer of the two above
//
// Each `sha256` is OpenSSL's (`openssl x509 -noout -fingerprint -sha256`), the form
// `tlsFingerprint` takes: an independent value for the tests to compare with.

export const testServerKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfERfS1n/E6GbqB3s
Qg4nXRLTxg/i6k4hUQNGSrqobImhRANCAAQmupb36nkkWEB3SvQjsGMX6YRFv9eP
xUQwoJAycNXcckMbz+gegZT8ccL4ek5Dy8wI4hRHeM1W+pub4Q7StmPh
-----END PRIVATE KEY-----
`;

export interface TestCertificate {
  readonly pem: string;
  /** Colon-separated uppercase hex SHA-256 of the DER bytes, as OpenSSL prints it. */
  readonly sha256: string;
  readonly subject: string;
  readonly issuer: string;
}

export const testCertificates = {
  selfSigned: {
    subject: 'CN=sealup test FTP server',
    issuer: 'CN=sealup test FTP server',
    sha256:
      'FE:F7:2D:37:AE:E6:22:4C:86:16:C1:E5:80:EC:21:04:16:85:E7:97:78:0C:8E:B4:25:B4:56:E4:98:D1:75:10',
    pem: `-----BEGIN CERTIFICATE-----
MIIBqjCCAVCgAwIBAgIUbCHrAvjc/XqGiMPU/DMWRcGsQX8wCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWc2VhbHVwIHRlc3QgRlRQIHNlcnZlcjAgFw0yNjEwMDkwNjI5
MjNaGA8yMTI2MDkxNTA2MjkyM1owITEfMB0GA1UEAwwWc2VhbHVwIHRlc3QgRlRQ
IHNlcnZlcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCa6lvfqeSRYQHdK9COw
YxfphEW/14/FRDCgkDJw1dxyQxvP6B6BlPxxwvh6TkPLzAjiFEd4zVb6m5vhDtK2
Y+GjZDBiMB0GA1UdDgQWBBT+wYFB0CmYX8PB3lemgNwDX7XgQzAfBgNVHSMEGDAW
gBT+wYFB0CmYX8PB3lemgNwDX7XgQzAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQI
MAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgfrgYzayrEnzAAJw9PD+u7ycbN/5q
oq3Dytu7l7q3o7kCIQDzfQaCeWnITZCIuulDX/gnPsnOUpknLs0vB6CxlKOC3A==
-----END CERTIFICATE-----
`,
  },
  trusted: {
    subject: 'CN=127.0.0.1',
    issuer: 'CN=sealup test CA',
    sha256:
      '31:E2:3E:08:C8:37:B4:4B:68:D3:FD:50:27:41:63:89:5A:F3:51:36:43:0C:67:F6:3A:99:8E:E7:23:F3:5D:4E',
    pem: `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgIUCg5RT/+tl2fu8h69p4gHVdVD1RswCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOc2VhbHVwIHRlc3QgQ0EwIBcNMjYxMDA5MDYyOTI0WhgPMjEy
NjA5MTUwNjI5MjRaMBQxEjAQBgNVBAMMCTEyNy4wLjAuMTBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABCa6lvfqeSRYQHdK9COwYxfphEW/14/FRDCgkDJw1dxyQxvP
6B6BlPxxwvh6TkPLzAjiFEd4zVb6m5vhDtK2Y+GjczBxMA8GA1UdEQQIMAaHBH8A
AAEwCQYDVR0TBAIwADATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU/sGB
QdApmF/Dwd5XpoDcA1+14EMwHwYDVR0jBBgwFoAUw6NWL47k2UvtW0gcMe/PT5CM
55IwCgYIKoZIzj0EAwIDSAAwRQIgH0MoQC6B8pd4QWoKAvMjkSeqq2mWuoN8rKva
BmXTD/ICIQDUO6tZmUca6BeCEcTh4aJnU6qbs9PkTlZKBbHdfJbcJQ==
-----END CERTIFICATE-----
`,
  },
  otherName: {
    subject: 'CN=ftp.example.com',
    issuer: 'CN=sealup test CA',
    sha256:
      '2A:1E:93:67:9B:90:A5:BF:DA:5A:50:E4:0F:F0:F1:15:89:25:70:AF:67:70:83:69:2E:1B:54:66:1F:E4:C3:12',
    pem: `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUCg5RT/+tl2fu8h69p4gHVdVD1RwwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOc2VhbHVwIHRlc3QgQ0EwIBcNMjYxMDA5MDYyOTI0WhgPMjEy
NjA5MTUwNjI5MjRaMBoxGDAWBgNVBAMMD2Z0cC5leGFtcGxlLmNvbTBZMBMGByqG
SM49AgEGCCqGSM49AwEHA0IABCa6lvfqeSRYQHdK9COwYxfphEW/14/FRDCgkDJw
1dxyQxvP6B6BlPxxwvh6TkPLzAjiFEd4zVb6m5vhDtK2Y+GjfjB8MBoGA1UdEQQT
MBGCD2Z0cC5leGFtcGxlLmNvbTAJBgNVHRMEAjAAMBMGA1UdJQQMMAoGCCsGAQUF
BwMBMB0GA1UdDgQWBBT+wYFB0CmYX8PB3lemgNwDX7XgQzAfBgNVHSMEGDAWgBTD
o1YvjuTZS+1bSBwx789PkIznkjAKBggqhkjOPQQDAgNIADBFAiEAx0bssGEKsQpq
rYlgMnjAvYmBhZ0YspYL2HpFe3dFxWwCIBNWWNBlpInshgM1NOaGCQlPLvkE1T+X
6JSEdD7/rxq7
-----END CERTIFICATE-----
`,
  },
} as const satisfies Record<string, TestCertificate>;

/** The test CA's certificate: what a test trusts to make `trusted` and `otherName` pass it. */
export const testCa = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT+gAwIBAgIUBp/ET/mAFAtPdHF+Lr0wgsnCbEIwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOc2VhbHVwIHRlc3QgQ0EwIBcNMjYxMDA5MDYyOTIzWhgPMjEy
NjA5MTUwNjI5MjNaMBkxFzAVBgNVBAMMDnNlYWx1cCB0ZXN0IENBMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAExTNvKzsMk/665pVnA/ZUpfz/MhTPgwPEksHQZnjp
TzNAil3ZJYXRWNfIsOY8LWr2xAwd+MVhdPrva1lb56W1kqNjMGEwHQYDVR0OBBYE
FMOjVi+O5NlL7VtIHDHvz0+QjOeSMB8GA1UdIwQYMBaAFMOjVi+O5NlL7VtIHDHv
z0+QjOeSMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49
BAMCA0cAMEQCICbsB0nLyUZdeLYu819JO0lbN4MXBqjGJzVjxP2VrTa7AiB2pMEy
NMRnqhTxFzTwc0h57ZGw07MZ+0UVllHm3C6kIA==
-----END CERTIFICATE-----
`;

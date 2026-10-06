#!/bin/sh
# Throwaway certificate chains for test/apple.test.ts, shaped like Apple's
# StoreKit chain (root → intermediate → leaf, EC P-256, Apple's marker
# extensions). Test-only keys; nothing here is trusted anywhere else.
#   trusted:  root.pem → intermediate.pem → leaf.pem (+ leaf.key)
#   evil:     evil-root.pem → evil-intermediate.pem → evil-leaf.pem (+ evil-leaf.key)
#   plain:    plain-leaf.pem (+ plain-leaf.key), issued by intermediate.pem
#             but without the App Store leaf extension
# Re-run from anywhere: sh test/fixtures/apple/make.sh (LibreSSL or OpenSSL)
set -e
cd "$(dirname "$0")"
DAYS=36500
cat > ext.cnf <<'CNF'
[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.11.1 = ASN1:NULL
[plain]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
CNF
key() { openssl ecparam -name prime256v1 -genkey -noout -out "$1"; }
chain() { # $1 = file prefix
  p=$1
  key "${p}root.key"
  key "${p}intermediate.key"
  key "${p}leaf.key"
  openssl req -new -x509 -days $DAYS -key "${p}root.key" -subj "/CN=${p}Test Root CA/O=Photoboot tests" \
    -config ext.cnf -extensions ca -out "${p}root.pem"
  openssl req -new -key "${p}intermediate.key" -subj "/CN=${p}Test Intermediate/O=Photoboot tests" -out i.csr
  openssl x509 -req -days $DAYS -in i.csr -CA "${p}root.pem" -CAkey "${p}root.key" -set_serial 2 \
    -extfile ext.cnf -extensions intermediate -out "${p}intermediate.pem"
  openssl req -new -key "${p}leaf.key" -subj "/CN=${p}Test Leaf/O=Photoboot tests" -out l.csr
  openssl x509 -req -days $DAYS -in l.csr -CA "${p}intermediate.pem" -CAkey "${p}intermediate.key" -set_serial 3 \
    -extfile ext.cnf -extensions leaf -out "${p}leaf.pem"
}
chain ""
chain "evil-"
key plain-leaf.key
openssl req -new -key plain-leaf.key -subj "/CN=Plain Leaf/O=Photoboot tests" -out l.csr
openssl x509 -req -days $DAYS -in l.csr -CA intermediate.pem -CAkey intermediate.key -set_serial 4 \
  -extfile ext.cnf -extensions plain -out plain-leaf.pem
rm -f i.csr l.csr ext.cnf root.key intermediate.key evil-root.key evil-intermediate.key

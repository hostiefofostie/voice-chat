import http.server, ssl, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
server = http.server.HTTPServer(('0.0.0.0', 8443), http.server.SimpleHTTPRequestHandler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('cert.pem', 'key.pem')
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print("HTTPS server at https://localhost:8443 and https://clawds-macbook-pro.taild6b854.ts.net:8443")
server.serve_forever()

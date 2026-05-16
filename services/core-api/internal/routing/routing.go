package routing

import "net/http"

type Router interface {
	Public(pattern string, handler http.HandlerFunc)
	Protected(pattern string, handler http.HandlerFunc)
}
